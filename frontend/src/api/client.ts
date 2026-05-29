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

export interface ExtractedFile {
  filename: string;
  text: string;
  char_count: number;
  method: string;
}

async function uploadExtract(file: File): Promise<ExtractedFile> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${BASE}/files/extract`, { method: "POST", body: fd });
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
  extractFile: uploadExtract,
};

export interface SearchSource {
  title: string;
  url: string;
}

export interface StreamHandlers {
  onToken: (provider: string, delta: string) => void;
  onDone: (provider: string, info: { latency_ms?: number }) => void;
  onError: (provider: string, message: string) => void;
  onSources?: (sources: SearchSource[], error: string | null) => void;
}

export async function streamChat(
  sessionId: string,
  prompt: string,
  opts: {
    compare: boolean;
    provider?: string;
    webSearch?: boolean;
    attachments?: { filename: string; text: string }[];
    signal?: AbortSignal;
  } & StreamHandlers
) {
  const path = opts.compare
    ? `/sessions/${sessionId}/compare`
    : `/sessions/${sessionId}/chat`;

  await fetchEventSource(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      provider: opts.provider,
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
      const known = ev.event === "token" || ev.event === "done" || ev.event === "error" || ev.event === "sources";
      if (!known) return;
      let data: {
        provider?: string;
        delta?: string;
        message?: string;
        latency_ms?: number;
        sources?: SearchSource[];
        error?: string | null;
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
