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
  // 호출자가 init.headers 를 넘기면 그것도 *병합* — 단순 spread 는
  // headers 를 통째로 덮어써 Authorization / Content-Type 이 사라지므로
  // 별도 merge.  X-Session-Passphrase 같은 추가 헤더가 안전하게 함께
  // 전송됨.
  const mergedHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...authHeaders(),
    ...((init?.headers as Record<string, string>) || {}),
  };
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: mergedHeaders,
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
      // 본문이 JSON 이 아니면 nginx 의 기본 413 같은 HTML 에러 페이지일
      // 가능성 — 그 경우 사용자가 알아볼 수 있는 한국어 hint 로 치환.
      if (res.status === 413) {
        const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
        detail =
          `리버스 프록시(nginx) 가 ${sizeMb} MB 업로드를 차단했어요. ` +
          "관리자에게 nginx 설정 `client_max_body_size` 를 백엔드의 " +
          "MAX_UPLOAD_BYTES (기본 25MB) 이상으로 맞춰 달라고 전해 주세요. " +
          "예시는 ops/nginx-aichat.conf.example 참고.";
      } else if (body.includes("<html") && body.includes("nginx")) {
        detail = `리버스 프록시 오류 (${res.status}) — 관리자에게 nginx 로그 확인을 요청해 주세요.`;
      }
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
  /** Additional roles beyond `role` (the primary). Editable from
   *  the role-picker popup in the user table. */
  extra_roles: string[];
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
  listAudit: (opts?: { event?: string; userQ?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.event) params.set("event", opts.event);
    if (opts?.userQ) params.set("user_q", opts.userQ);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return json<Array<{
      id: string;
      user_id: string | null;
      user_email: string;
      event: string;
      ip: string;
      user_agent: string;
      detail: string;
      created_at: string | null;
    }>>(`/admin/audit${qs ? "?" + qs : ""}`);
  },
  forceLogoutUser: (userId: string) =>
    json<{
      user_id: string;
      email: string;
      tokens_invalidated_at: string;
      by: string;
    }>(`/admin/users/${userId}/logout-all`, { method: "POST" }),
  listActiveSessions: () =>
    json<Array<{
      user_id: string;
      email: string;
      role: string;
      last_login_at: string;
      tokens_invalidated_at: string | null;
    }>>("/admin/active-sessions"),
  systemResources: () =>
    json<{
      cpu: { percent: number; cores: number; load_avg: number[] };
      memory: {
        total: number; used: number; available: number; pct: number;
        swap_total: number; swap_used: number; swap_pct: number;
      };
      disks: Array<{
        path: string; total?: number; used?: number; free?: number;
        pct?: number; error?: string;
      }>;
      gpu: Array<{
        index: number; name: string;
        memory_used_mb: number; memory_total_mb: number;
        utilization_pct: number; temperature_c: number;
      }> | null;
    }>("/admin/system-resources"),
  modelUsage: (days = 30) =>
    json<Array<{
      provider: string;
      calls: number;
      tokens_out: number;
      avg_latency_ms: number;
      input_rate_krw_per_1k: number;
      output_rate_krw_per_1k: number;
      estimated_cost_krw: number;
    }>>(`/admin/model-usage?days=${days}`),
  userActivity: (days = 30, limit = 100) =>
    json<Array<{
      user_id: string;
      email: string;
      role: string;
      session_count: number;
      msg_count: number;
      tokens_out: number;
      logins: number;
      last_message_at: string | null;
      last_login_at: string | null;
    }>>(`/admin/user-activity?days=${days}&limit=${limit}`),
  listBackups: () =>
    json<{
      backup_dir: string;
      files: Array<{ name: string; size_bytes: number; mtime: string }>;
    }>("/admin/backups"),
  createBackup: () =>
    json<{ name: string; size_bytes: number; mtime: string }>(
      "/admin/backups", { method: "POST" },
    ),
  deleteBackup: (name: string) =>
    json<void>(`/admin/backups/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  listErrors: (limit = 50) =>
    json<{
      transcripts: Array<{
        id: string;
        user_email: string;
        source_filename: string;
        session_id: string | null;
        error: string;
        created_at: string | null;
        updated_at: string | null;
      }>;
      projects: Array<{
        id: string;
        owner_email: string;
        name: string;
        source_type: string;
        error: string;
        created_at: string | null;
        updated_at: string | null;
      }>;
      workflows: Array<{
        id: string;
        user_email: string;
        name: string;
        last_error: string;
        last_session_id: string | null;
        last_run_at: string | null;
      }>;
      app_errors: Array<{
        id: string;
        level: string;
        source: string;
        message: string;
        traceback: string | null;
        path: string | null;
        method: string | null;
        status_code: number | null;
        user_email: string | null;
        ip: string | null;
        created_at: string | null;
      }>;
    }>(`/admin/errors?limit=${limit}`),
  // ── 사용자별 사용량 통계 (#41) ────────────────────────
  listUsage: (days = 30, limit = 200) =>
    json<{
      days: number;
      items: {
        user_id: string;
        email: string;
        name: string;
        message_count: number;
        tokens_out_sum: number;
        avg_latency_ms: number | null;
        last_activity: string | null;
      }[];
    }>(`/admin/usage?days=${days}&limit=${limit}`),
  // ── 답변 품질 분석 (#37) ──────────────────────────────
  listDisliked: (limit = 100) =>
    json<
      {
        message_id: string;
        session_id: string;
        session_title: string;
        user_email: string;
        provider: string | null;
        content: string;
        feedback_note: string | null;
        created_at: string | null;
      }[]
    >(`/admin/disliked?limit=${limit}`),
  // ── 시스템 헬스 (#39) ────────────────────────────────
  health: () =>
    json<{
      ollama: { ok: boolean; latency_ms?: number; error?: string; models?: number };
      qdrant: { ok: boolean; latency_ms?: number; error?: string; collections?: number };
      db: { ok: boolean; latency_ms?: number; error?: string };
      errors_24h: number;
      checked_at: string;
    }>("/admin/health"),
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
  /** Replace the user's *additional* role grants (everything beyond
   *  the primary role) with `roleCodes`. Pass an empty array to
   *  clear all extras. */
  setUserRoles: (userId: string, roleCodes: string[]) =>
    json<AdminUser>(`/admin/users/${userId}/roles`, {
      method: "PATCH",
      body: JSON.stringify({ role_codes: roleCodes }),
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
  /** Per-file indexing outcome shown as a ✓ / ⊘ marker in the
   *  upload list. Mirrors the code workspace tree's status markers. */
  index_status:
    | "indexed"
    | "pending"
    | "oversize"
    | "unsupported-ext"
    | "empty"
    | "no-snapshot";
  chunk_count: number | null;
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
  /** How many snapshots the indexer keeps per project; older ones
   *  are auto-pruned after each successful reindex. 0 = unlimited. */
  snapshot_retention_count: number;
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
  skip_holidays: boolean;
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
  status: "pending" | "transcribing" | "diarizing" | "summarizing" | "ok" | "failed" | "archived";
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
  /** 다운로드 엔드포인트 호출에 필요. */
  project_id?: string | null;
  /** 청크가 인용된 RAG 프로젝트 이름 (UI 출처 표기). */
  project_name?: string | null;
  /** false = 다른 관리자가 공유한 KB 의 청크. true = 본인 소유. */
  project_owned?: boolean;
}

export const api = {
  listProviders: () => json<ProviderInfo[]>("/providers"),
  listOllamaModels: () => json<OllamaModelList>("/ollama/models"),
  listSessions: (deleted = false) =>
    json<Session[]>(`/sessions${deleted ? "?deleted=true" : ""}`),
  getSession: (id: string, passphrase?: string) =>
    json<SessionDetail>(
      `/sessions/${id}`,
      passphrase
        ? { headers: { "X-Session-Passphrase": passphrase } }
        : undefined,
    ),
  /** Create a session, optionally pre-filed under a chat project. */
  createSession: (title: string, chatProjectId?: string | null) =>
    json<Session>("/sessions", {
      method: "POST",
      body: JSON.stringify({
        title,
        chat_project_id: chatProjectId ?? null,
      }),
    }),
  /** Default = soft-delete (휴지통).  permanent=true 면 즉시 영구. */
  deleteSession: (id: string, permanent = false) =>
    json<void>(
      `/sessions/${id}${permanent ? "?permanent=true" : ""}`,
      { method: "DELETE" },
    ),
  /** 휴지통에서 복원. */
  restoreSession: (id: string) =>
    json<Session>(`/sessions/${id}/restore`, { method: "POST" }),
  /** 사이드바 고정 토글. */
  pinSession: (id: string, pinned: boolean) =>
    json<Session>(`/sessions/${id}/pin`, {
      method: "PATCH",
      body: JSON.stringify({ pinned }),
    }),
  /** 여러 세션 일괄 작업. */
  bulkSessions: (
    ids: string[],
    action: "delete" | "restore" | "permanent-delete" | "pin" | "unpin",
  ) =>
    json<void>("/sessions/bulk", {
      method: "POST",
      body: JSON.stringify({ session_ids: ids, action }),
    }),
  /** 공유 링크 생성 (#38). */
  createSessionShare: (id: string, expiresDays: number | null = null) =>
    json<{
      id: string;
      token: string;
      url: string;
      expires_at: string | null;
      created_at: string;
    }>(`/sessions/${id}/share`, {
      method: "POST",
      body: JSON.stringify({ expires_days: expiresDays }),
    }),
  getSharedSession: (token: string) =>
    json<SessionDetail>(`/sessions/_share/${token}`),
  /** 세션 비밀번호 잠금 (#52). */
  lockSession: (id: string, passphrase: string | null) =>
    json<Session>(`/sessions/${id}/lock`, {
      method: "PATCH",
      body: JSON.stringify({ passphrase }),
    }),
  unlockSession: (id: string, passphrase: string) =>
    json<SessionDetail>(`/sessions/${id}/unlock`, {
      method: "POST",
      body: JSON.stringify({ passphrase }),
    }),
  /** 시스템 매크로 (#48). */
  listSystemMacros: () =>
    json<{ id: string; name: string; body: string }[]>("/system-macros"),
  createSystemMacro: (name: string, body: string) =>
    json<{ id: string; name: string; body: string }>("/system-macros", {
      method: "POST",
      body: JSON.stringify({ name, body }),
    }),
  deleteSystemMacro: (id: string) =>
    json<void>(`/system-macros/${id}`, { method: "DELETE" }),
  /** 메시지 번역 (#40). */
  translateMessage: (
    sessionId: string,
    messageId: string,
    target: "ko" | "en" | "ja" | "zh" = "ko",
  ) =>
    json<{ text: string; target: string }>(
      `/sessions/${sessionId}/messages/${messageId}/translate`,
      {
        method: "POST",
        body: JSON.stringify({ target }),
      },
    ),
  // ── API 키 (#45) ──────────────────────────────────────
  listApiKeys: () =>
    json<{
      id: string;
      label: string;
      token_prefix: string;
      last_used_at: string | null;
      expires_at: string | null;
      created_at: string | null;
    }[]>("/keys"),
  createApiKey: (label: string, expiresDays: number | null = null) =>
    json<{
      id: string;
      label: string;
      token: string;
      token_prefix: string;
      created_at: string | null;
      expires_at: string | null;
    }>("/keys", {
      method: "POST",
      body: JSON.stringify({ label, expires_days: expiresDays }),
    }),
  revokeApiKey: (id: string) =>
    json<void>(`/keys/${id}`, { method: "DELETE" }),
  updateSession: (id: string, title: string) =>
    json<Session>(`/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  /** Edit a message in place — the chat bubble's pencil action
   *  posts the new content here so the user can fix a mis-
   *  transcription or tighten the AI summary without asking the
   *  model to redo the turn. */
  updateMessage: (
    sessionId: string,
    messageId: string,
    content: string,
  ) =>
    json<{
      id: string;
      role: "user" | "assistant";
      content: string;
      hidden: boolean;
    }>(`/sessions/${sessionId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    }),
  /** 별표(starred) + 답변 평가(feedback). 본문 수정과 분리된 가벼운 PATCH —
   *  한 번에 부분 필드만 보낸다 (서버에서 null = 그대로). */
  updateMessageMeta: (
    sessionId: string,
    messageId: string,
    patch: {
      starred?: boolean;
      feedback?: -1 | 0 | 1;
      feedback_note?: string | null;
      tags?: string[];
    },
  ) =>
    json<{
      id: string;
      starred: boolean;
      feedback: number;
      feedback_note: string | null;
      tags: string[] | null;
    }>(`/sessions/${sessionId}/messages/${messageId}/meta`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  // ── 사용자 슬래시 매크로 (#33) ─────────────────────────────
  listMacros: () =>
    json<
      { id: string; name: string; body: string; created_at: string | null; updated_at: string | null }[]
    >("/macros"),
  createMacro: (name: string, body: string) =>
    json<{ id: string; name: string; body: string }>("/macros", {
      method: "POST",
      body: JSON.stringify({ name, body }),
    }),
  updateMacro: (id: string, name: string, body: string) =>
    json<{ id: string; name: string; body: string }>(`/macros/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, body }),
    }),
  deleteMacro: (id: string) =>
    json<void>(`/macros/${id}`, { method: "DELETE" }),
  /** 사용자가 별표한 메시지를 다른 세션 가리지 않고 한 번에 모아 옴. */
  /** 메시지 수정 후 재생성 / 재생성 흐름의 핵심 — 주어진 메시지 이후
   *  의 모든 메시지를 삭제. 대상 메시지 자체는 보존. */
  /** 짧은 오디오 한 토막을 Whisper 로 전사해 텍스트만 반환. 채팅 composer
   *  🎙 마이크 입력에서 사용. */
  transcribeInline: async (audio: Blob): Promise<{ text: string; duration: number }> => {
    const form = new FormData();
    const ext = audio.type.includes("webm") ? "webm" : audio.type.includes("ogg") ? "ogg" : "wav";
    form.append("file", audio, `voice.${ext}`);
    const res = await fetch(`${BASE}/transcripts/_inline`, {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });
    if (!res.ok) {
      let detail = `${res.status}`;
      try { detail = (await res.json()).detail ?? detail; } catch {}
      throw new Error(detail);
    }
    return res.json();
  },
  /** 주어진 메시지 시점에서 새 세션으로 분기 — 이력 복사 후 새 ID 반환. */
  branchSessionFrom: (sessionId: string, messageId: string) =>
    json<Session>(
      `/sessions/${sessionId}/messages/${messageId}/branch`,
      { method: "POST" },
    ),
  rewindSessionAfter: (sessionId: string, messageId: string) =>
    json<void>(
      `/sessions/${sessionId}/messages/${messageId}/rewind`,
      { method: "POST" },
    ),
  listStarredMessages: () =>
    json<Array<{
      id: string;
      role: "user" | "assistant";
      provider: string | null;
      content: string;
      session_id?: string;
      created_at: string;
      starred: boolean;
      feedback: number;
      feedback_note: string | null;
    }>>("/sessions/_starred"),
  /** 세션을 HWPX (한컴 오픈 XML) 로 내보내기. 한글 2014 SE+ 에서
   *  직접 열림. include / maskPii 동작은 docx 와 동일. */
  exportSessionHwpx: async (
    sessionId: string,
    title: string,
    include: "all" | "summary" | "starred" = "all",
    maskPii = false,
  ) => {
    const qs = new URLSearchParams({ include, mask_pii: String(maskPii) });
    const res = await fetch(
      `${BASE}/sessions/${sessionId}/export.hwpx?${qs.toString()}`,
      { headers: authHeaders() },
    );
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title || "session"}.hwpx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  /** 회의록을 HWPX 로 다운로드. opts 는 docx 와 동일. */
  exportTranscriptHwpx: async (
    id: string,
    title: string,
    opts?: {
      messageIds?: string[];
      include?: "summary" | "all";
      maskPii?: boolean;
    },
  ) => {
    const params = new URLSearchParams();
    if (opts?.messageIds && opts.messageIds.length > 0) {
      params.set("message_ids", opts.messageIds.join(","));
    } else if (opts?.include) {
      params.set("include", opts.include);
    }
    if (opts?.maskPii) params.set("mask_pii", "true");
    const qs = params.toString();
    const res = await fetch(
      `${BASE}/transcripts/${id}/export.hwpx${qs ? "?" + qs : ""}`,
      { headers: authHeaders() },
    );
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title || "transcript"}.hwpx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  /** 세션을 DOCX 로 내보내기. include: all | summary | starred.
   *  maskPii=true 면 주민번호 · 전화 · 이메일 · 카드번호 · 여권번호를
   *  비대칭 마스킹해서 저장 (원문 복구 불가). */
  exportSessionDocx: async (
    sessionId: string,
    title: string,
    include: "all" | "summary" | "starred" = "all",
    maskPii = false,
  ) => {
    const qs = new URLSearchParams({ include, mask_pii: String(maskPii) });
    const res = await fetch(
      `${BASE}/sessions/${sessionId}/export.docx?${qs.toString()}`,
      { headers: authHeaders() },
    );
    if (!res.ok) {
      throw new Error(`Export failed: ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title || "session"}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
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
  /** Naver 쇼핑 단일 호출. sort = sim(정확도) / date(최신) /
   *  asc(낮은가격) / dsc(높은가격).  관리자가 NAVER_CLIENT_ID/
   *  SECRET 을 .env 에 넣지 않았다면 503 으로 떨어진다. */
  searchShop: (
    q: string,
    opts: {
      sort?: "sim" | "date" | "asc" | "dsc";
      display?: number;
      start?: number;
      mall?: string;
      /** 쉼표 구분 provider 목록. 비우거나 "all" 이면 활성 전체. */
      sources?: string;
    } = {},
  ) => {
    const params = new URLSearchParams({
      q,
      sort: opts.sort ?? "sim",
      display: String(opts.display ?? 30),
      start: String(opts.start ?? 1),
    });
    if (opts.mall) params.set("mall", opts.mall);
    if (opts.sources) params.set("sources", opts.sources);
    return json<{
      items: {
        title: string;
        link: string;
        image: string;
        lprice: number | null;
        hprice: number | null;
        mall: string;
        brand: string;
        category: string;
        productId: string;
        source: "naver" | "eleven_st" | "coupang" | string;
      }[];
      sort: "sim" | "date" | "asc" | "dsc";
      query: string;
      providers: {
        name: string;
        enabled: boolean;
        count: number;
        error: string | null;
      }[];
    }>(`/search/shop?${params.toString()}`);
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
    /** How many snapshots to keep per project (0 = unlimited).
     *  Defaults to 10 on the backend if omitted. */
    snapshot_retention_count?: number;
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
      snapshot_retention_count?: number;
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
  ): Promise<{
    files: RagUploadedFile[];
    errors: { filename: string; reason: string }[];
  }> => {
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
      // Whole-request rejection (403 / 409 / etc.) — the per-file
      // partial-success path returns 200 with errors inside the body.
      const body = await res.text();
      let detail = body;
      try {
        detail = JSON.parse(body).detail ?? body;
      } catch {
        // not JSON
      }
      throw new Error(detail || `${res.status}`);
    }
    return (await res.json()) as {
      files: RagUploadedFile[];
      errors: { filename: string; reason: string }[];
    };
  },
  /** Trigger a browser download for an uploaded file. The fetch
   *  carries the bearer token (cookies don't survive cross-origin
   *  dev setups), then we hand the resulting blob to a synthesised
   *  <a download> click so the file lands in the user's downloads
   *  folder with the original name. Slash separators in the path are
   *  preserved (matches the backend's `{filename:path}` route) and
   *  individual segments get percent-encoded. */
  downloadProjectUpload: async (id: string, filename: string) => {
    const safe = filename
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    const res = await fetch(
      `${BASE}/projects/${id}/uploads/${safe}/download`,
      { headers: authHeaders() },
    );
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
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // The fetch response's Content-Disposition has the proper name;
    // browsers DO read it when the URL is blob:, but only some — pass
    // the basename through `download` so the result is consistent.
    a.download = filename.split("/").pop() || filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Free the blob slot after a tick so the click handler has time
    // to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    skip_holidays?: boolean;
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
      skip_holidays: boolean;
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
  /** Whisper model availability — admin-only. The Cowork meetings
   *  pane uses this to show a "모델 다운로드" CTA when the closed-
   *  network install hasn't been completed yet. */
  whisperStatus: () =>
    json<{
      enabled: boolean;
      offline: boolean;
      model: string;
      model_dir: string;
      cached_snapshot: string | null;
      ready: boolean;
      download: {
        status: "idle" | "running" | "done" | "failed";
        model: string;
        local_dir: string;
        error: string | null;
      };
    }>("/transcripts/_whisper-status"),
  /** Kick off a background snapshot_download into WHISPER_MODEL_DIR.
   *  Admin-only. Returns the running state — poll whisperStatus()
   *  until status flips to "done" / "failed". */
  whisperDownload: () =>
    json<{
      status: "idle" | "running" | "done" | "failed";
      model: string;
      local_dir: string;
      error: string | null;
    }>("/transcripts/_whisper-download", { method: "POST" }),
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
  renameTranscript: (id: string, title: string) =>
    json<Transcript>(`/transcripts/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  /** Download the transcript's chat session as a Korean 회의록 DOCX.
   *  Optional `messageIds` lets the caller hand-pick which messages
   *  to include (selection modal). When omitted, only assistant
   *  messages (the polished summary) land in the document — raw
   *  transcript is hidden by default. */
  exportTranscriptDocx: async (
    id: string,
    title: string,
    opts?: {
      messageIds?: string[];
      include?: "summary" | "all";
      maskPii?: boolean;
    },
  ) => {
    const params = new URLSearchParams();
    if (opts?.messageIds && opts.messageIds.length > 0) {
      params.set("message_ids", opts.messageIds.join(","));
    } else if (opts?.include) {
      params.set("include", opts.include);
    }
    if (opts?.maskPii) params.set("mask_pii", "true");
    const qs = params.toString();
    const res = await fetch(
      `${BASE}/transcripts/${id}/export.docx${qs ? "?" + qs : ""}`,
      { headers: authHeaders() },
    );
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
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title} 회의록.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

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
  /** 어떤 테스트 러너가 감지됐는지 — 트리 툴바가 버튼을 보일지 결정. */
  workspaceTestRunner: (id: string) =>
    json<{ enabled: boolean; runner: string | null }>(
      `/code/workspaces/${id}/test-runner`,
    ),
  runWorkspaceTests: (id: string) =>
    json<{
      runner: string | null;
      ok: boolean;
      skipped: boolean;
      reason?: string;
      exit_code: number | null;
      stdout: string;
      stderr: string;
      duration_ms: number;
    }>(`/code/workspaces/${id}/run-tests`, { method: "POST" }),
  /** 워크스페이스 전체를 zip 으로 받는다. .git / node_modules / 빌드
   *  산출물 자동 제외, 50 MB 초과 시 서버가 409. */
  /** 청크가 인용한 원본 문서를 다운로드. upload/folder 소스는 원본
   *  파일, 그 외는 청크 텍스트 .txt 로 fallback. */
  downloadChunkSource: async (
    projectId: string,
    filename: string,
    startLine: number,
    endLine: number,
  ) => {
    const qs = new URLSearchParams({
      filename,
      start_line: String(startLine),
      end_line: String(endLine),
    });
    const res = await fetch(
      `${BASE}/projects/${projectId}/chunk-source?${qs.toString()}`,
      { headers: authHeaders() },
    );
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const j = await res.json();
        detail = j.detail ?? detail;
      } catch { /* not JSON */ }
      throw new Error(detail);
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const dlname = m
      ? decodeURIComponent(m[1])
      : filename.split("/").pop() || "chunk.txt";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = dlname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  downloadWorkspaceZip: async (id: string) => {
    const res = await fetch(
      `${BASE}/code/workspaces/${id}/download.zip`,
      { headers: authHeaders() },
    );
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const j = await res.json();
        detail = j.detail ?? detail;
      } catch { /* not JSON */ }
      throw new Error(detail);
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const filename = m ? decodeURIComponent(m[1]) : "workspace.zip";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  /** Per-file bundle inclusion status the chat side panel uses to
   *  mark each row in the tree with ✓ / ⊘ icons + tooltips. Runs
   *  the exact same `collect_workspace_files` pass the next chat
   *  turn will see so the markers are real, not stale stats. */
  workspaceBundleStatus: (id: string) =>
    json<{
      total_files_in_repo: number;
      bundled_files: number;
      bundled_bytes: number;
      skipped_too_large: number;
      skipped_unsupported_ext: number;
      walk_error: string | null;
      file_status: Record<string, string>;
      caps: {
        max_files: number;
        max_total_bytes: number;
        max_bytes_per_file: number;
      };
    }>(`/code/workspaces/${id}/bundle-status`),
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
  /** 디스크에 쓰지 않고 LLM 이 만든 새 파일 내용 vs 기존 파일의 unified
   *  diff 만 받아 온다. 미리보기 모달 → "적용" 누르면 그제서야 applyWorkspaceFile. */
  previewWorkspaceFile: (id: string, path: string, content: string) =>
    json<{
      path: string;
      added: boolean;
      unchanged: boolean;
      diff: string;
      old_lines: number;
      new_lines: number;
    }>(`/code/workspaces/${id}/preview`, {
      method: "POST",
      body: JSON.stringify({ path, content }),
    }),
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
  // ── 워크스페이스 grep (#54) ───────────────────────────────
  workspaceGrep: (
    id: string,
    q: string,
    opts: { regex?: boolean; caseSensitive?: boolean; limit?: number } = {},
  ) => {
    const params = new URLSearchParams({ q });
    if (opts.regex) params.set("regex", "true");
    if (opts.caseSensitive) params.set("case_sensitive", "true");
    if (opts.limit) params.set("limit", String(opts.limit));
    return json<{
      query: string;
      count: number;
      results: { path: string; line: number; snippet: string }[];
    }>(`/code/workspaces/${id}/grep?${params.toString()}`);
  },
  // ── 빌드 / 린트 / 포맷 (#56) ─────────────────────────────
  runWorkspaceCommand: (
    id: string,
    kind: "build" | "lint" | "format",
  ) =>
    json<{
      runner: string | null;
      kind: string;
      ok: boolean;
      skipped: boolean;
      reason?: string;
      exit_code: number | null;
      stdout: string;
      stderr: string;
      duration_ms: number;
    }>(`/code/workspaces/${id}/run-command?kind=${kind}`, {
      method: "POST",
    }),
  // ── AI 코드 리뷰 (#57) ───────────────────────────────────
  aiReviewWorkspace: (id: string) =>
    json<{ review: string; diff_bytes: number; model: string }>(
      `/code/workspaces/${id}/ai-review`,
      { method: "POST" },
    ),
  // ── AI 커밋 메시지 (#58) ─────────────────────────────────
  aiCommitMessageWorkspace: (id: string) =>
    json<{ message: string; model: string }>(
      `/code/workspaces/${id}/ai-commit-message`,
      { method: "POST" },
    ),
  // ── 인앱 편집 저장 (#53) ─────────────────────────────────
  saveWorkspaceFile: (id: string, path: string, content: string) =>
    json<{ path: string; size: number; sha256: string }>(
      `/code/workspaces/${id}/save-file`,
      {
        method: "POST",
        body: JSON.stringify({ path, content }),
      },
    ),
  // ── 특정 리비전 파일 (Monaco DiffEditor 용, #55) ─────────
  workspaceFileAtRev: (id: string, path: string, rev = "HEAD") =>
    json<{ path: string; rev: string; text: string }>(
      `/code/workspaces/${id}/file-at-rev?path=${encodeURIComponent(
        path,
      )}&rev=${encodeURIComponent(rev)}`,
    ),
  // ── 브랜치 (#59) ─────────────────────────────────────────
  workspaceBranches: (id: string) =>
    json<{ current: string; local: string[]; remote: string[] }>(
      `/code/workspaces/${id}/branches`,
    ),
  workspaceSwitchBranch: (id: string, name: string, create = false) =>
    json<{ current: string; stdout: string }>(
      `/code/workspaces/${id}/switch-branch`,
      { method: "POST", body: JSON.stringify({ name, create }) },
    ),
  // ── git log (#60) ───────────────────────────────────────
  workspaceLog: (id: string, limit = 50) =>
    json<{
      commits: {
        sha: string;
        short_sha: string;
        author_name: string;
        author_email: string;
        when: string;
        subject: string;
      }[];
    }>(`/code/workspaces/${id}/log?limit=${limit}`),
  workspaceCommitFiles: (id: string, sha: string) =>
    json<{
      sha: string;
      files: { status: string; path: string }[];
    }>(`/code/workspaces/${id}/commit/${encodeURIComponent(sha)}`),
  workspaceCommitFileDiff: (id: string, sha: string, path: string) =>
    json<{ sha: string; path: string; diff: string }>(
      `/code/workspaces/${id}/commit/${encodeURIComponent(
        sha,
      )}?path=${encodeURIComponent(path)}`,
    ),
  // ── 파일 CRUD (#61) ─────────────────────────────────────
  workspaceCreatePath: (
    id: string,
    path: string,
    kind: "file" | "dir" = "file",
  ) =>
    json<{ path: string; kind: string }>(
      `/code/workspaces/${id}/path`,
      { method: "POST", body: JSON.stringify({ path, kind }) },
    ),
  workspaceDeletePath: (id: string, path: string) =>
    json<{ path: string; deleted: boolean }>(
      `/code/workspaces/${id}/path?path=${encodeURIComponent(path)}`,
      { method: "DELETE" },
    ),
  workspaceRenamePath: (id: string, src: string, dst: string) =>
    json<{ src: string; dst: string }>(
      `/code/workspaces/${id}/path`,
      { method: "PATCH", body: JSON.stringify({ src, dst }) },
    ),
  // ── find & replace (#62) ────────────────────────────────
  workspaceReplace: (
    id: string,
    opts: {
      query: string;
      replacement: string;
      regex?: boolean;
      caseSensitive?: boolean;
      dryRun?: boolean;
    },
  ) =>
    json<{
      dry_run: boolean;
      total_files: number;
      total_replacements: number;
      files: { path: string; count: number }[];
    }>(`/code/workspaces/${id}/replace`, {
      method: "POST",
      body: JSON.stringify({
        query: opts.query,
        replacement: opts.replacement,
        regex: !!opts.regex,
        case_sensitive: !!opts.caseSensitive,
        dry_run: opts.dryRun !== false,
      }),
    }),
  // ── TODO / FIXME 인덱스 (#63) ───────────────────────────
  workspaceTodos: (id: string, limit = 500) =>
    json<{
      count: number;
      items: { path: string; line: number; tag: string; message: string }[];
    }>(`/code/workspaces/${id}/todos?limit=${limit}`),
  // ── 워크스페이스 통계 (#64) ─────────────────────────────
  workspaceStats: (id: string) =>
    json<{
      file_count: number;
      total_loc: number;
      total_bytes: number;
      languages: { lang: string; files: number; loc: number; bytes: number }[];
      biggest_files: { path: string; size: number }[];
    }>(`/code/workspaces/${id}/stats`),
  // ── 스태시 관리 (#65) ────────────────────────────────────
  workspaceStashes: (id: string) =>
    json<{ stashes: { index: string; message: string; when: string }[] }>(
      `/code/workspaces/${id}/stashes`,
    ),
  workspaceStashSave: (id: string, message = "") =>
    json<{ stdout: string }>(`/code/workspaces/${id}/stash`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  workspaceStashApply: (id: string, ref: string, pop = true) =>
    json<{ stdout: string }>(`/code/workspaces/${id}/stash/apply`, {
      method: "POST",
      body: JSON.stringify({ ref, pop }),
    }),
  workspaceStashDrop: (id: string, ref: string) =>
    json<{ dropped: string }>(
      `/code/workspaces/${id}/stash?ref=${encodeURIComponent(ref)}`,
      { method: "DELETE" },
    ),
  // ── 머지 conflict (#66) ──────────────────────────────────
  workspaceConflicts: (id: string) =>
    json<{ paths: string[] }>(`/code/workspaces/${id}/conflicts`),
  workspaceConflictVersions: (id: string, path: string) =>
    json<{
      path: string;
      base: string;
      ours: string;
      theirs: string;
      merged: string;
    }>(
      `/code/workspaces/${id}/conflict?path=${encodeURIComponent(path)}`,
    ),
  workspaceConflictResolve: (id: string, path: string, content: string) =>
    json<{ path: string; resolved: boolean }>(
      `/code/workspaces/${id}/conflict/resolve`,
      { method: "POST", body: JSON.stringify({ path, content }) },
    ),
  // ── 사용자 정의 task (#67) ───────────────────────────────
  workspaceCustomTasks: (id: string) =>
    json<{
      tasks: { id: string; name: string; description: string; timeout: number }[];
    }>(`/code/workspaces/${id}/custom-tasks`),
  workspaceCustomTaskRun: (id: string, taskId: string) =>
    json<{
      name: string;
      ok: boolean;
      exit_code: number | null;
      stdout: string;
      stderr: string;
      duration_ms: number;
    }>(`/code/workspaces/${id}/custom-tasks/run`, {
      method: "POST",
      body: JSON.stringify({ task_id: taskId }),
    }),
  // ── AI 리팩터 / 테스트 생성 (#68) ─────────────────────────
  workspaceAiRefactor: (id: string, path: string) =>
    json<{ path: string; review: string; model: string }>(
      `/code/workspaces/${id}/ai-refactor`,
      { method: "POST", body: JSON.stringify({ path }) },
    ),
  workspaceAiTests: (id: string, path: string) =>
    json<{ path: string; tests: string; model: string }>(
      `/code/workspaces/${id}/ai-tests`,
      { method: "POST", body: JSON.stringify({ path }) },
    ),
  // ── 파일 타임라인 (#70) ──────────────────────────────────
  workspaceFileTimeline: (id: string, path: string, limit = 50) =>
    json<{
      path: string;
      commits: {
        sha: string;
        short_sha: string;
        author_name: string;
        when: string;
        subject: string;
      }[];
      chats: {
        message_id: string;
        session_id: string;
        role: string;
        snippet: string;
        when: string | null;
      }[];
    }>(
      `/code/workspaces/${id}/file-timeline?path=${encodeURIComponent(
        path,
      )}&limit=${limit}`,
    ),
  // ── 코드 스니펫 (#71) ────────────────────────────────────
  listSnippets: () =>
    json<
      {
        id: string;
        scope: "personal" | "team";
        name: string;
        body: string;
        language: string;
        description: string;
        owned: boolean;
      }[]
    >("/snippets"),
  createSnippet: (payload: {
    name: string;
    body: string;
    language?: string;
    description?: string;
    scope?: "personal" | "team";
  }) =>
    json<{
      id: string;
      scope: "personal" | "team";
      name: string;
      body: string;
      language: string;
      description: string;
      owned: boolean;
    }>("/snippets", { method: "POST", body: JSON.stringify(payload) }),
  deleteSnippet: (id: string) =>
    json<void>(`/snippets/${id}`, { method: "DELETE" }),
  // ── AI 문서화 (#72) ──────────────────────────────────────
  workspaceAiDocument: (id: string, path: string) =>
    json<{ path: string; documented: string; model: string }>(
      `/code/workspaces/${id}/ai-document`,
      { method: "POST", body: JSON.stringify({ path }) },
    ),
  // ── AI 보안 점검 (#74) ───────────────────────────────────
  workspaceSecurityScan: (id: string) =>
    json<{
      count: number;
      findings: { path: string; line: number; label: string; snippet: string }[];
      summary: string;
      model: string;
    }>(`/code/workspaces/${id}/security-scan`, { method: "POST" }),
  // ── git 태그 (#75) ───────────────────────────────────────
  workspaceTags: (id: string) =>
    json<{ tags: { name: string; sha: string; subject: string }[] }>(
      `/code/workspaces/${id}/tags`,
    ),
  workspaceTagCreate: (
    id: string,
    name: string,
    message = "",
    ref = "HEAD",
  ) =>
    json<{ name: string; ref: string }>(`/code/workspaces/${id}/tag`, {
      method: "POST",
      body: JSON.stringify({ name, message, ref }),
    }),
  workspaceTagDelete: (id: string, name: string) =>
    json<{ deleted: string }>(
      `/code/workspaces/${id}/tag?name=${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),
  workspaceTagPush: (id: string, name: string) =>
    json<{ pushed: string }>(`/code/workspaces/${id}/tag/push`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  // ── 의존성 dashboard (#76) ───────────────────────────────
  workspaceDependencies: (id: string) =>
    json<{
      managers: Record<
        string,
        { name: string; version: string; type: string }[]
      >;
    }>(`/code/workspaces/${id}/dependencies`),
  // ── 체리픽 / 리셋 (#77) ──────────────────────────────────
  workspaceCherryPick: (id: string, sha: string) =>
    json<{ sha: string; stdout: string }>(
      `/code/workspaces/${id}/cherry-pick`,
      { method: "POST", body: JSON.stringify({ sha }) },
    ),
  workspaceReset: (
    id: string,
    sha: string,
    mode: "soft" | "mixed" | "hard",
  ) =>
    json<{ sha: string; mode: string; stdout: string }>(
      `/code/workspaces/${id}/reset`,
      { method: "POST", body: JSON.stringify({ sha, mode }) },
    ),
  // ── 브랜치 비교 (#78) ────────────────────────────────────
  workspaceCompare: (id: string, base: string, head: string) =>
    json<{
      base: string;
      head: string;
      files: { status: string; path: string }[];
    }>(
      `/code/workspaces/${id}/compare?base=${encodeURIComponent(
        base,
      )}&head=${encodeURIComponent(head)}`,
    ),
  workspaceCompareFile: (
    id: string,
    base: string,
    head: string,
    path: string,
  ) =>
    json<{
      path: string;
      base: string;
      head: string;
      diff: string;
    }>(
      `/code/workspaces/${id}/compare/file?base=${encodeURIComponent(
        base,
      )}&head=${encodeURIComponent(head)}&path=${encodeURIComponent(path)}`,
    ),
  // ── 파일 outline (#80) ───────────────────────────────────
  workspaceOutline: (id: string, path: string) =>
    json<{
      path: string;
      items: { kind: string; name: string; line: number; level?: number }[];
    }>(`/code/workspaces/${id}/outline?path=${encodeURIComponent(path)}`),
  // ── 컨트리뷰터 (#81) ─────────────────────────────────────
  workspaceContributors: (id: string, limit = 50) =>
    json<{
      contributors: {
        commits: number;
        name: string;
        email: string;
        last_at: string | null;
      }[];
    }>(`/code/workspaces/${id}/contributors?limit=${limit}`),
  // ── 활동 히트맵 (#82) ────────────────────────────────────
  workspaceActivity: (id: string, days = 365) =>
    json<{
      days: number;
      weekday_hour: { weekday: number; hour: number; count: number }[];
      by_day: { date: string; count: number }[];
    }>(`/code/workspaces/${id}/activity?days=${days}`),
  // ── 심볼 전역 검색 (#83) ─────────────────────────────────
  workspaceSymbols: (id: string, q: string, limit = 200) => {
    const params = new URLSearchParams({ q, limit: String(limit) });
    return json<{
      query: string;
      count: number;
      items: { path: string; line: number; kind: string; name: string }[];
    }>(`/code/workspaces/${id}/symbols?${params.toString()}`);
  },
  // ── AI changelog (#84) ───────────────────────────────────
  workspaceAiChangelog: (id: string, days = 7) =>
    json<{
      days: number;
      commits: number;
      changelog: string;
      model: string;
    }>(`/code/workspaces/${id}/ai-changelog?days=${days}`, {
      method: "POST",
    }),
  // ── drag-drop 파일 업로드 (#85) ──────────────────────────
  workspaceUploadFile: async (id: string, path: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("path", path);
    const res = await fetch(`/api/code/workspaces/${id}/upload-file`, {
      method: "POST",
      body: fd,
      headers: { Authorization: `Bearer ${getToken() ?? ""}` },
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`${res.status} ${t}`);
    }
    return (await res.json()) as { path: string; size: number };
  },
  // ── zip import (#86) ─────────────────────────────────────
  workspaceImportZip: async (id: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/code/workspaces/${id}/import-zip`, {
      method: "POST",
      body: fd,
      headers: { Authorization: `Bearer ${getToken() ?? ""}` },
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`${res.status} ${t}`);
    }
    return (await res.json()) as {
      extracted: number;
      total_bytes: number;
      skipped_count: number;
      skipped_sample: string[];
    };
  },
  // ── 다중 일괄 삭제 (#87) ─────────────────────────────────
  workspaceBulkDelete: (id: string, paths: string[]) =>
    json<{
      deleted: string[];
      failed: { path: string; error: string }[];
    }>(`/code/workspaces/${id}/bulk-delete`, {
      method: "POST",
      body: JSON.stringify({ paths }),
    }),
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
  kind?: "web" | "news" | "shop" | "blog" | "cafe" | "wiki";
  /** 어느 외부 소스에서 왔는지 — naver / kakao / duckduckgo / wikipedia-ko/en */
  source?: string;
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
    ragFilenameFilter?: string;
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
      rag_filename_filter: opts.ragFilenameFilter ?? undefined,
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
