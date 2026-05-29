import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { Mode, ProviderInfo, Session, SessionDetail } from "../types";

const BASE = "/api";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  listProviders: () => json<ProviderInfo[]>("/providers"),
  listSessions: () => json<Session[]>("/sessions"),
  getSession: (id: string) => json<SessionDetail>(`/sessions/${id}`),
  createSession: (title: string, mode: Mode) =>
    json<Session>("/sessions", {
      method: "POST",
      body: JSON.stringify({ title, mode }),
    }),
  deleteSession: (id: string) =>
    json<void>(`/sessions/${id}`, { method: "DELETE" }),
};

export interface StreamHandlers {
  onToken: (provider: string, delta: string) => void;
  onDone: (provider: string, info: { latency_ms?: number }) => void;
  onError: (provider: string, message: string) => void;
}

export async function streamChat(
  sessionId: string,
  prompt: string,
  opts: { compare: boolean; provider?: string; signal?: AbortSignal } & StreamHandlers
) {
  const path = opts.compare
    ? `/sessions/${sessionId}/compare`
    : `/sessions/${sessionId}/chat`;

  await fetchEventSource(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, provider: opts.provider }),
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
      const data = JSON.parse(ev.data);
      if (ev.event === "token") opts.onToken(data.provider, data.delta);
      else if (ev.event === "done") opts.onDone(data.provider, data);
      else if (ev.event === "error") opts.onError(data.provider, data.message);
    },
    onerror(err) {
      throw err;
    },
  });
}
