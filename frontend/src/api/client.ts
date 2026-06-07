import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { ChatProject, ProviderInfo, Session, SessionDetail } from "../types";

const BASE = "/api";
const TOKEN_KEY = "chat:access_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...authHeaders() },
    ...init,
  });
  if (!res.ok) {
    if (res.status === 401) {
      setToken(null);
      // Surface to AuthContext via a synthetic event so it can clear state.
      window.dispatchEvent(new CustomEvent("chat:unauthorized"));
    }
    const body = await res.text();
    let detail = body;
    try {
      detail = JSON.parse(body).detail ?? body;
    } catch {
      /* not JSON */
    }
    throw new HttpError(res.status, `${res.status} ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface ExtractedFile {
  filename: string;
  text: string;
  char_count: number;
  method: string;
  /** Base64 of the original bytes when the attachment is an image. The
   *  chat router forwards this to vision-capable Ollama models as the
   *  `images` field of the user message. */
  image_b64?: string | null;
}

async function uploadExtract(file: File): Promise<ExtractedFile> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${BASE}/files/extract`, {
    method: "POST",
    body: fd,
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.text();
    let detail = body;
    try {
      detail = JSON.parse(body).detail ?? body;
    } catch {
      // not JSON
    }
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json();
}

/** POST a set of files to the merge endpoint. Returns the merged
 *  blob + a server-suggested filename pulled from the
 *  Content-Disposition header (falls back to a generic name when
 *  the header isn't present or unparseable). */
async function mergeFiles(opts: {
  files: File[];
  title: string;
  withSeparators: boolean;
}): Promise<{ blob: Blob; filename: string }> {
  const fd = new FormData();
  for (const f of opts.files) fd.append("files", f, f.name);
  fd.append("title", opts.title);
  fd.append("with_separators", opts.withSeparators ? "true" : "false");
  const res = await fetch(`${BASE}/files/merge`, {
    method: "POST",
    body: fd,
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.text();
    let detail = body;
    try {
      detail = JSON.parse(body).detail ?? body;
    } catch {
      // not JSON
    }
    throw new Error(detail || `${res.status}`);
  }
  const disp = res.headers.get("Content-Disposition") || "";
  let filename = "merged";
  // Prefer RFC-5987 `filename*=UTF-8''<urlencoded>` form (what the
  // backend sends for Korean titles) and fall back to a plain
  // `filename="..."` for older clients.
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disp);
  if (star) {
    try {
      filename = decodeURIComponent(star[1]);
    } catch {
      filename = star[1];
    }
  } else {
    const plain = /filename="?([^";]+)"?/i.exec(disp);
    if (plain) filename = plain[1];
  }
  const blob = await res.blob();
  return { blob, filename };
}

/** Compact attachment record stored alongside a persisted user
 *  message so the chat bubble can render filename + type chips on
 *  reload. Mirrors `AttachmentSummary` on the backend. */
export interface AttachmentSummary {
  filename: string;
  kind: "image" | "file";
  size: number;
}

/** Single hit from the global chat search endpoint. The snippet is
 *  a short window of the message body centred on the first match —
 *  ready to render with the query highlighted client-side. */
export interface MessageSearchResult {
  message_id: string;
  session_id: string;
  session_title: string;
  role: "user" | "assistant";
  snippet: string;
  /** "content" = matched in the message body; "attachment" = matched
   *  in the attachments_summary JSON. Lets the dialog group the
   *  "I'm looking for a file" hits under their own section. */
  match_in: "content" | "attachment";
  created_at: string;
}

export type UserStatus = "pending" | "approved" | "rejected" | "suspended";
/** Role is now a free-form code looked up against the `roles` table.
 *  The three built-ins still exist (admin/moderator/user) and most
 *  call sites still work with them, but the type intentionally
 *  widens to `string` so custom codes round-trip cleanly. */
export type UserRole = string;
export type BuiltinRole = "user" | "moderator" | "admin";

export interface Role {
  code: string;
  name: string;
  description: string | null;
  base_role: BuiltinRole;
  is_system: boolean;
  created_at: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  email_verified: boolean;
  status: UserStatus;
  role: UserRole;
  approved_at: string | null;
  rejection_reason: string | null;
  suspension_reason: string | null;
  signup_reason: string | null;
  created_at: string;
}
export interface AdminUser extends AuthUser {
  approved_by_id: string | null;
  suspended_at: string | null;
  suspended_by_id: string | null;
  updated_at: string;
}
export interface AuthResponse {
  user: AuthUser;
  access_token: string;
  token_type: string;
  expires_at: string;
}
/** Signup may complete without an access token when the account
 *  lands in pending state — the caller must branch on `status`. */
export interface SignupResponse {
  user: AuthUser;
  access_token: string | null;
  token_type: string;
  expires_at: string | null;
  status: "pending" | "approved";
}

export interface AuditEvent {
  id: string;
  event: string;
  ip: string;
  user_agent: string;
  detail: string;
  created_at: string;
}

export const auth = {
  signup: (
    email: string,
    password: string,
    name: string,
    signupReason = "",
  ) =>
    json<SignupResponse>("/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        name,
        signup_reason: signupReason,
      }),
    }),
  login: (email: string, password: string) =>
    json<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: () => json<AuthUser>("/me"),
  updateMe: (payload: {
    name?: string;
    current_password?: string;
    new_password?: string;
  }) =>
    json<AuthUser>("/me", { method: "PATCH", body: JSON.stringify(payload) }),
  deleteMe: () => json<void>("/me", { method: "DELETE" }),
  myAudit: (limit = 50) =>
    json<AuditEvent[]>(`/me/audit?limit=${limit}`),

  resendVerify: () =>
    json<void>("/auth/verify-email/send", { method: "POST" }),
  verifyEmail: (token: string) =>
    json<AuthUser>("/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  requestPasswordReset: (email: string) =>
    json<void>("/auth/password-reset/request", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  confirmPasswordReset: (token: string, new_password: string) =>
    json<AuthResponse>("/auth/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify({ token, new_password }),
    }),
};

export interface AppSettings {
  auto_approve_signups: boolean;
}

export const admin = {
  getSettings: () => json<AppSettings>("/admin/settings"),
  updateSettings: (patch: Partial<AppSettings>) =>
    json<AppSettings>("/admin/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  listUsers: (opts?: { status?: string; role?: string; q?: string }) => {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.role) params.set("role", opts.role);
    if (opts?.q) params.set("q", opts.q);
    const qs = params.toString();
    return json<AdminUser[]>(`/admin/users${qs ? "?" + qs : ""}`);
  },
  pendingCount: () => json<{ count: number }>("/admin/pending-count"),
  approve: (userId: string) =>
    json<AdminUser>(`/admin/users/${userId}/approve`, { method: "POST" }),
  reject: (userId: string, reason: string) =>
    json<AdminUser>(`/admin/users/${userId}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  setRole: (userId: string, role: UserRole) =>
    json<AdminUser>(`/admin/users/${userId}/role`, {
      method: "POST",
      body: JSON.stringify({ role }),
    }),
  suspend: (userId: string, reason: string) =>
    json<AdminUser>(`/admin/users/${userId}/suspend`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  unsuspend: (userId: string) =>
    json<AdminUser>(`/admin/users/${userId}/unsuspend`, { method: "POST" }),
  listRoles: () => json<Role[]>("/admin/roles"),
  createRole: (payload: {
    code: string;
    name: string;
    description: string;
    base_role: BuiltinRole;
  }) =>
    json<Role>("/admin/roles", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateRole: (
    code: string,
    payload: {
      name?: string;
      description?: string;
      base_role?: BuiltinRole;
    },
  ) =>
    json<Role>(`/admin/roles/${encodeURIComponent(code)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteRole: (code: string) =>
    json<void>(`/admin/roles/${encodeURIComponent(code)}`, {
      method: "DELETE",
    }),
};

export interface OllamaModel {
  name: string;
  size: number;
  parameter_size: string | null;
}
export interface OllamaModelList {
  current: string;
  models: OllamaModel[];
}

export type CorpusType = "code" | "document" | "api" | "db";
export type SourceType =
  | "folder"
  | "git"
  | "url"
  | "connection"
  | "sftp"
  | "upload";

export interface RagUploadedFile {
  filename: string;
  size: number;
  modified_at: string;
}

export interface DbDriverInfo {
  code: string;
  label: string;
  default_port: number | null;
  is_file_based: boolean;
  odbc_based: boolean;
  default_database: string;
  notes: string;
}

export interface DbTestResult {
  ok: boolean;
  driver: string;
  url_redacted: string;
  error: string | null;
  table_count: number | null;
}

export interface SqlPreviewResult {
  ok: boolean;
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  error: string | null;
}

export interface Snapshot {
  id: string;
  label: string;
  status: "pending" | "indexing" | "ready" | "failed";
  progress_done: number;
  progress_total: number;
  file_count: number;
  chunk_count: number;
  error: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  source_type: SourceType;
  source_ref: string;
  corpus_type: CorpusType;
  status: "pending" | "indexing" | "ready" | "failed";
  progress_done: number;
  progress_total: number;
  file_count: number;
  chunk_count: number;
  error: string | null;
  current_snapshot_id: string | null;
  snapshots: Snapshot[];
  schedule_interval_minutes: number;
  last_indexed_at: string | null;
  created_at: string;
  /** Shared knowledge base — exposed to the roles in role_codes and
   *  auto-searched in chat for those users. */
  is_shared: boolean;
  role_codes: string[];
  /** Per-project SELECT for the connection source. Exposed so the
   *  edit form can pre-fill it (null on non-DB sources). */
  sql_query: string | null;
  api_detail_key: string | null;
  api_detail_url: string | null;
  /** False when the user is accessing this as a shared knowledge base
   *  they don't own — the UI hides delete / reindex in that case. */
  owned: boolean;
}

export interface Prompt {
  id: string;
  code: string;
  name: string;
  description: string | null;
  body: string;
  category: string | null;
  tags: string | null;
  is_shared: boolean;
  role_codes: string[];
  owned: boolean;
  created_at: string;
  updated_at: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string | null;
  prompt_id: string;
  prompt_name: string | null;
  prompt_vars: Record<string, string> | null;
  project_id: string | null;
  project_name: string | null;
  model: string | null;
  schedule_interval_minutes: number;
  enabled: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  last_session_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Transcript {
  id: string;
  source_filename: string;
  size_bytes: number;
  duration_sec: number | null;
  status: "pending" | "transcribing" | "diarizing" | "summarizing" | "ok" | "failed";
  progress: number | null;
  language: string | null;
  diarized: boolean;
  session_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  source_type: "git" | "local";
  git_url: string;
  branch: string;
  local_path: string;
  auth_username: string | null;
  status: "cloning" | "ready" | "failed";
  error: string | null;
  file_count: number;
  size_bytes: number;
  last_synced_at: string | null;
  created_at: string;
}
export interface WorkspaceTreeEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  children: WorkspaceTreeEntry[];
}
export interface WorkspaceFile {
  path: string;
  text: string;
  size: number;
  truncated: boolean;
  method: string;
}
export interface WorkspaceStatusEntry {
  path: string;
  x: string;
  y: string;
  status: string;
  label: string;
}

export interface RagChunk {
  filename: string;
  start_line: number;
  end_line: number;
  score: number;
}

export const api = {
  listProviders: () => json<ProviderInfo[]>("/providers"),
  listOllamaModels: () => json<OllamaModelList>("/ollama/models"),
  listSessions: () => json<Session[]>("/sessions"),
  getSession: (id: string) => json<SessionDetail>(`/sessions/${id}`),
  /** Create a session, optionally pre-filed under a chat project. */
  createSession: (title: string, chatProjectId?: string | null) =>
    json<Session>("/sessions", {
      method: "POST",
      body: JSON.stringify({
        title,
        chat_project_id: chatProjectId ?? null,
      }),
    }),
  deleteSession: (id: string) =>
    json<void>(`/sessions/${id}`, { method: "DELETE" }),
  updateSession: (id: string, title: string) =>
    json<Session>(`/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  /** Move a session into a chat project (folder), or detach by
   *  passing null. The sidebar uses this from each session row. */
  moveSessionToChatProject: (sessionId: string, projectId: string | null) =>
    json<Session>(`/sessions/${sessionId}/chat-project`, {
      method: "PATCH",
      body: JSON.stringify({ chat_project_id: projectId }),
    }),

  // ── Chat projects (sidebar folders) ─────────────────────────────
  listChatProjects: () => json<ChatProject[]>("/chat-projects"),
  createChatProject: (payload: {
    name: string;
    description?: string;
    instructions?: string;
  }) =>
    json<ChatProject>("/chat-projects", {
      method: "POST",
      body: JSON.stringify({
        name: payload.name,
        description: payload.description ?? "",
        instructions: payload.instructions ?? "",
      }),
    }),
  updateChatProject: (
    id: string,
    payload: Partial<{ name: string; description: string; instructions: string }>,
  ) =>
    json<ChatProject>(`/chat-projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteChatProject: (id: string) =>
    json<{ ok: boolean }>(`/chat-projects/${id}`, { method: "DELETE" }),
  extractFile: uploadExtract,
  mergeFiles,
  /** Global chat search — scans every message the caller owns
   *  (across all sessions) for a substring match and returns short
   *  snippets centred on the first hit. Matches both message content
   *  and the attachment summary column so filename lookups work too.
   *  Queries shorter than 2 characters return an empty list. */
  searchMessages: (q: string, limit = 50) => {
    const params = new URLSearchParams({ q, limit: String(limit) });
    return json<MessageSearchResult[]>(`/search/messages?${params.toString()}`);
  },
  /** Persist a two-message record of a `/병합` exchange so the chat
   *  surface shows what happened — the user's slash command and an
   *  assistant-style "병합 완료" confirmation with the merged
   *  filename as an attachment chip. The actual merged bytes are
   *  NOT stored; the download already happened browser-side. */
  logMerge: (
    sessionId: string,
    payload: {
      user_prompt: string;
      source_filenames: string[];
      result_filename: string;
      result_size: number;
    },
  ) =>
    json<
      {
        id: string;
        role: "user" | "assistant";
        provider: string | null;
        content: string;
        attachments_summary: AttachmentSummary[] | null;
        created_at: string;
      }[]
    >(`/sessions/${sessionId}/log-merge`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // RAG / Projects
  /** Catalog of supported DB connection drivers (postgresql, mysql,
   *  mariadb, sqlite, mssql, tibero, cubrid, altibase). Used by the
   *  project-creation form to render driver-specific fields and pick
   *  default ports / file-based shape. */
  listDbDrivers: () => json<DbDriverInfo[]>("/projects/_db-drivers"),
  /** Build a SA URL from the form fields server-side and attempt a
   *  real connection. Returns `{ ok, table_count?, error? }`. */
  testDbConnection: (payload: {
    driver: string;
    host?: string;
    port?: number | null;
    user?: string;
    password?: string;
    database?: string;
  }) =>
    json<DbTestResult>("/projects/_db-test", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  /** Preview the SELECT the user is about to attach to the project.
   *  Returns up to `limit` rows + their column names so the form
   *  can render a sample table next to the SQL textarea. */
  previewDbSql: (payload: {
    driver: string;
    host?: string;
    port?: number | null;
    user?: string;
    password?: string;
    database?: string;
    sql: string;
    limit?: number;
  }) =>
    json<SqlPreviewResult>("/projects/_db-sql-preview", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  listProjects: () => json<Project[]>("/projects"),
  getProject: (id: string) => json<Project>(`/projects/${id}`),
  createProject: (payload: {
    name: string;
    source_type: SourceType;
    source_ref: string;
    ref?: string;
    corpus_type?: CorpusType;
    /** Only meaningful for source_type='connection' — backend silently
     *  drops it on other source types so a stray value can't pollute
     *  an unrelated project's indexing run. */
    sql_query?: string | null;
    /** API list→detail collection (url source only). */
    api_detail_key?: string | null;
    api_detail_url?: string | null;
    /** Admin-only: create as a shared knowledge base exposed to the
     *  given role codes. */
    is_shared?: boolean;
    role_codes?: string[];
  }) =>
    json<Project>("/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  /** Preview the API list→detail collection before creating: returns
   *  total list size + a few sampled detail records. */
  previewApiDetails: (payload: {
    list_url: string;
    detail_key: string;
    detail_url: string;
    limit?: number;
  }) =>
    json<{
      ok: boolean;
      error?: string;
      total?: number;
      sampled?: number;
      records?: { _key: string; _url: string; _body: unknown }[];
    }>("/projects/_api-preview", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  /** Admin-only: replace the role→project access grants for a shared
   *  knowledge base (marks it shared if it wasn't). */
  updateProjectAccess: (id: string, roleCodes: string[]) =>
    json<Project>(`/projects/${id}/access`, {
      method: "PATCH",
      body: JSON.stringify({ role_codes: roleCodes }),
    }),
  /** PATCH editable fields on an existing project. Pass only the
   *  fields you want to change. Source-defining changes (source_ref /
   *  sql_query / api_detail_*) invalidate the index — backend
   *  triggers a fresh snapshot automatically. */
  updateProject: (
    id: string,
    payload: {
      name?: string;
      source_ref?: string;
      ref?: string;
      sql_query?: string | null;
      api_detail_key?: string | null;
      api_detail_url?: string | null;
      is_shared?: boolean;
      role_codes?: string[];
    },
  ) =>
    json<Project>(`/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  reindexProject: (id: string) =>
    json<Project>(`/projects/${id}/reindex`, { method: "POST" }),
  /** List files the user has uploaded under the project's 내 문서
   *  업로드 directory. Only valid for source_type='upload' projects. */
  listProjectUploads: (id: string) =>
    json<RagUploadedFile[]>(`/projects/${id}/uploads`),
  /** Append one or more files to the project's upload directory. The
   *  caller decides when to trigger reindex — this endpoint doesn't
   *  rebuild the index by itself. When a file came from a folder
   *  picker (webkitdirectory), its `webkitRelativePath` is preserved
   *  as the upload name so the backend can recreate the subdirectory
   *  structure under the project's upload dir. */
  uploadProjectFiles: async (
    id: string,
    files: File[],
  ): Promise<RagUploadedFile[]> => {
    const fd = new FormData();
    for (const f of files) {
      const rel =
        (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
        f.name;
      fd.append("files", f, rel);
    }
    const res = await fetch(`${BASE}/projects/${id}/uploads`, {
      method: "POST",
      body: fd,
      headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.text();
      let detail = body;
      try {
        detail = JSON.parse(body).detail ?? body;
      } catch {
        // not JSON
      }
      throw new Error(detail || `${res.status}`);
    }
    return (await res.json()) as RagUploadedFile[];
  },
  /** Delete one file by its relative path under the project's upload
   *  directory. The backend route uses `{filename:path}` so the slash
   *  separators must NOT be percent-encoded — split on / and encode
   *  each component instead so unusual characters in folder/file
   *  names still survive. */
  deleteProjectUpload: (id: string, filename: string) => {
    const safe = filename
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return json<{ ok: boolean }>(`/projects/${id}/uploads/${safe}`, {
      method: "DELETE",
    });
  },
  deleteProject: (id: string) =>
    json<{ freed_bytes: number }>(`/projects/${id}`, { method: "DELETE" }),
  projectStorage: () =>
    json<{ total_bytes: number; project_count: number }>("/projects/_storage"),
  activateSnapshot: (projectId: string, snapshotId: string) =>
    json<Project>(
      `/projects/${projectId}/snapshots/${snapshotId}/activate`,
      { method: "POST" },
    ),
  deleteSnapshot: (projectId: string, snapshotId: string) =>
    json<{ freed_bytes: number }>(
      `/projects/${projectId}/snapshots/${snapshotId}`,
      { method: "DELETE" },
    ),
  refreshProject: (projectId: string) =>
    json<Project>(`/projects/${projectId}/refresh`, { method: "POST" }),
  setProjectSchedule: (projectId: string, intervalMinutes: number) =>
    json<Project>(`/projects/${projectId}/schedule`, {
      method: "PATCH",
      body: JSON.stringify({ schedule_interval_minutes: intervalMinutes }),
    }),

  // Code workspaces
  workspaceConstraints: () =>
    json<{
      allowed_hosts: string[];
      local_roots: string[];
      max_files: number;
      max_size_mb: number;
      clone_depth: number;
      bundle_max_files: number;
      bundle_max_total_bytes: number;
      bundle_max_per_file_bytes: number;
    }>("/code/_constraints"),
  // Prompts (personal + shared)
  listPrompts: () => json<Prompt[]>("/prompts"),
  createPrompt: (payload: {
    code: string;
    name: string;
    description?: string;
    body: string;
    category?: string;
    tags?: string;
    is_shared?: boolean;
    role_codes?: string[];
  }) =>
    json<Prompt>("/prompts", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updatePrompt: (
    id: string,
    payload: Partial<{
      name: string;
      description: string;
      body: string;
      category: string;
      tags: string;
      is_shared: boolean;
      role_codes: string[];
    }>,
  ) =>
    json<Prompt>(`/prompts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deletePrompt: (id: string) =>
    json<void>(`/prompts/${id}`, { method: "DELETE" }),

  // Workflows (per-user automation)
  listWorkflows: () => json<Workflow[]>("/workflows"),
  createWorkflow: (payload: {
    name: string;
    description?: string;
    prompt_id: string;
    prompt_vars?: Record<string, string> | null;
    project_id?: string | null;
    model?: string | null;
    schedule_interval_minutes?: number;
    enabled?: boolean;
  }) =>
    json<Workflow>("/workflows", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateWorkflow: (
    id: string,
    payload: Partial<{
      name: string;
      description: string;
      prompt_id: string;
      prompt_vars: Record<string, string> | null;
      project_id: string | null;
      model: string | null;
      schedule_interval_minutes: number;
      enabled: boolean;
    }>,
  ) =>
    json<Workflow>(`/workflows/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteWorkflow: (id: string) =>
    json<void>(`/workflows/${id}`, { method: "DELETE" }),
  runWorkflow: (id: string) =>
    json<Workflow>(`/workflows/${id}/run`, { method: "POST" }),

  // Transcripts (회의록/강의 전사 + 요약)
  listTranscripts: () => json<Transcript[]>("/transcripts"),
  uploadTranscript: async (file: File | Blob, filename?: string): Promise<Transcript> => {
    const fd = new FormData();
    fd.append("file", file, filename || (file instanceof File ? file.name : "녹음.webm"));
    const res = await fetch(`${BASE}/transcripts`, {
      method: "POST",
      body: fd,
      headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.text();
      let detail = body;
      try {
        detail = JSON.parse(body).detail ?? body;
      } catch { /* not JSON */ }
      throw new Error(detail || `${res.status}`);
    }
    return (await res.json()) as Transcript;
  },
  deleteTranscript: (id: string) =>
    json<void>(`/transcripts/${id}`, { method: "DELETE" }),

  listWorkspaces: () => json<Workspace[]>("/code/workspaces"),
  createWorkspace: (payload: {
    name: string;
    source_type?: "git" | "local";
    git_url?: string;
    branch?: string;
    auth_username?: string;
    auth_token?: string;
    local_path?: string;
  }) =>
    json<Workspace>("/code/workspaces", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deleteWorkspace: (id: string) =>
    json<{ freed_bytes: number }>(`/code/workspaces/${id}`, {
      method: "DELETE",
    }),
  syncWorkspace: (id: string) =>
    json<Workspace>(`/code/workspaces/${id}/sync`, { method: "POST" }),
  workspaceTree: (id: string) =>
    json<{
      tree: WorkspaceTreeEntry[];
      file_count: number;
      size_bytes: number;
    }>(`/code/workspaces/${id}/tree`),
  workspaceFile: (id: string, path: string) =>
    json<WorkspaceFile>(
      `/code/workspaces/${id}/file?path=${encodeURIComponent(path)}`,
    ),
  startChatFromWorkspace: (id: string) =>
    json<{
      session_id: string;
      title: string;
      workspace_id: string;
      workspace_name: string;
      reused: boolean;
      file_count: number;
      truncated: boolean;
      total_files_in_repo: number;
    }>(`/code/workspaces/${id}/start-chat`, { method: "POST" }),

  // Phase 2 — apply / status / diff / commit / push
  applyWorkspaceFile: (id: string, path: string, content: string) =>
    json<{ path: string; size: number; created: boolean }>(
      `/code/workspaces/${id}/apply`,
      { method: "POST", body: JSON.stringify({ path, content }) },
    ),
  workspaceStatus: (id: string) =>
    json<{
      entries: WorkspaceStatusEntry[];
      clean: boolean;
      // Local-folder sources without a .git directory: status route
      // returns git=false so the UI can hide the commit panel
      // instead of showing a misleading "no changes" message.
      git?: boolean;
    }>(`/code/workspaces/${id}/status`),
  workspaceDiff: (id: string, path?: string) =>
    json<{ diff: string; path: string | null }>(
      `/code/workspaces/${id}/diff${
        path ? `?path=${encodeURIComponent(path)}` : ""
      }`,
    ),
  revertWorkspaceFile: (id: string, path: string) =>
    json<{ path: string; removed: boolean }>(
      `/code/workspaces/${id}/revert`,
      { method: "POST", body: JSON.stringify({ path }) },
    ),
  commitWorkspace: (
    id: string,
    payload: { message: string; paths?: string[]; push?: boolean },
  ) =>
    json<{
      commit: {
        committed: boolean;
        sha: string | null;
        summary: string | null;
        files: string[];
      };
      push: { pushed: boolean; branch?: string; error?: string } | null;
    }>(`/code/workspaces/${id}/commit`, {
      method: "POST",
      body: JSON.stringify({
        message: payload.message,
        paths: payload.paths ?? [],
        push: payload.push ?? false,
      }),
    }),
  pushWorkspace: (id: string) =>
    json<{ pushed: boolean; branch?: string }>(
      `/code/workspaces/${id}/push`,
      { method: "POST" },
    ),
};

export interface SearchSource {
  title: string;
  url: string;
  kind?: "web" | "news" | "shop";
  image?: string | null;
  snippet?: string | null;
  mall?: string | null;
  lprice?: number | null;
}

export interface StreamHandlers {
  onToken: (provider: string, delta: string) => void;
  onDone: (provider: string, info: { latency_ms?: number }) => void;
  onError: (provider: string, message: string) => void;
  onSources?: (sources: SearchSource[], error: string | null) => void;
  onModel?: (provider: string, name: string, reason: string) => void;
  onRag?: (chunks: RagChunk[]) => void;
}

export async function streamChat(
  sessionId: string,
  prompt: string,
  opts: {
    provider: string;
    model?: string | null;
    webSearch?: boolean;
    attachments?: { filename: string; text: string; image_b64?: string | null }[];
    projectId?: string | null;
    signal?: AbortSignal;
  } & StreamHandlers
) {
  await fetchEventSource(`${BASE}/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      prompt,
      provider: opts.provider,
      model: opts.model ?? undefined,
      web_search: !!opts.webSearch,
      attachments: opts.attachments ?? [],
      project_id: opts.projectId ?? undefined,
    }),
    signal: opts.signal,
    openWhenHidden: true,
    async onopen(res) {
      if (res.ok && res.headers.get("content-type")?.includes("text/event-stream")) return;
      const body = await res.text();
      let detail = body;
      try {
        detail = JSON.parse(body).detail ?? body;
      } catch {
        // not JSON, keep raw text
      }
      throw new Error(`${res.status} ${detail}`);
    },
    onmessage(ev) {
      if (!ev.data) return; // ignore keepalive / empty pings
      const known =
        ev.event === "token" ||
        ev.event === "done" ||
        ev.event === "error" ||
        ev.event === "sources" ||
        ev.event === "model" ||
        ev.event === "rag";
      if (!known) return;
      let data: {
        provider?: string;
        delta?: string;
        message?: string;
        latency_ms?: number;
        sources?: SearchSource[];
        error?: string | null;
        name?: string;
        reason?: string;
        chunks?: RagChunk[];
      };
      try {
        data = JSON.parse(ev.data);
      } catch {
        console.warn("SSE: non-JSON data ignored", ev.event, ev.data);
        return;
      }
      if (ev.event === "sources") {
        opts.onSources?.(data.sources ?? [], data.error ?? null);
        return;
      }
      if (ev.event === "model") {
        opts.onModel?.(
          data.provider ?? "unknown",
          data.name ?? "",
          data.reason ?? "",
        );
        return;
      }
      if (ev.event === "rag") {
        opts.onRag?.(data.chunks ?? []);
        return;
      }
      const provider = data.provider ?? "unknown";
      if (ev.event === "token") opts.onToken(provider, data.delta ?? "");
      else if (ev.event === "done") opts.onDone(provider, { latency_ms: data.latency_ms });
      else if (ev.event === "error") opts.onError(provider, data.message ?? "unknown error");
    },
    onerror(err) {
      throw err;
    },
  });
}
