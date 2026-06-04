import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { ProviderInfo, Session, SessionDetail } from "../types";

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

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  email_verified: boolean;
  created_at: string;
}
export interface AuthResponse {
  user: AuthUser;
  access_token: string;
  token_type: string;
  expires_at: string;
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
  signup: (email: string, password: string, name: string) =>
    json<AuthResponse>("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
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

export interface OllamaModel {
  name: string;
  size: number;
  parameter_size: string | null;
}
export interface OllamaModelList {
  current: string;
  models: OllamaModel[];
}

export const api = {
  listProviders: () => json<ProviderInfo[]>("/providers"),
  listOllamaModels: () => json<OllamaModelList>("/ollama/models"),
  cloneRepo: (url: string, ref?: string) =>
    json<{
      files: ExtractedFile[];
      skipped: Record<string, number>;
      repo: string;
    }>("/repo/clone", {
      method: "POST",
      body: JSON.stringify({ url, ref: ref || undefined }),
    }),
  listSessions: () => json<Session[]>("/sessions"),
  getSession: (id: string) => json<SessionDetail>(`/sessions/${id}`),
  createSession: (title: string) =>
    json<Session>("/sessions", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  deleteSession: (id: string) =>
    json<void>(`/sessions/${id}`, { method: "DELETE" }),
  updateSession: (id: string, title: string) =>
    json<Session>(`/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  extractFile: uploadExtract,
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
}

export async function streamChat(
  sessionId: string,
  prompt: string,
  opts: {
    provider: string;
    model?: string | null;
    webSearch?: boolean;
    attachments?: { filename: string; text: string }[];
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
        ev.event === "model";
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
