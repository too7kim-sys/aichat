import { useSyncExternalStore } from "react";
import { streamChat, type RagChunk, type SearchSource } from "../api/client";

/**
 * Live state for a single in-flight chat response, indexed by sessionId.
 *
 * The stream lifecycle is held outside any React component so that
 * navigating away from a chat mid-stream and back doesn't abort the
 * response (the SSE connection keeps running, tokens keep landing in
 * `buffer`, and the chat panel that next mounts for this sessionId
 * subscribes to the same object).
 */
export interface PickedModel {
  name: string;
  reason: string;
}

export interface LiveStream {
  sessionId: string;
  prompt: string;
  buffer: string; // accumulated assistant text
  sources: SearchSource[] | null;
  searchWarning: string | null;
  startedAt: number;
  done: boolean;
  errors: string[];
  abort: () => void;
  // Populated when the chat request asked for model="auto" and the
  // server picked something on the user's behalf.
  pickedModel: PickedModel | null;
  // RAG chunks the server retrieved before generation.
  ragChunks: RagChunk[] | null;
}

type Listener = () => void;

class StreamStore {
  private streams = new Map<string, LiveStream>();
  private listeners = new Set<Listener>();

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  get(sessionId: string): LiveStream | undefined {
    return this.streams.get(sessionId);
  }

  isStreaming(sessionId: string): boolean {
    const s = this.streams.get(sessionId);
    return !!s && !s.done;
  }

  start(params: {
    sessionId: string;
    prompt: string;
    provider: string;
    model?: string | null;
    webSearch?: boolean;
    attachments?: { filename: string; text: string }[];
    projectId?: string | null;
    onComplete?: (errors: string[]) => void;
  }): boolean {
    if (this.isStreaming(params.sessionId)) return false;

    const controller = new AbortController();
    let buffer = "";
    const errors: string[] = [];
    const stream: LiveStream = {
      sessionId: params.sessionId,
      prompt: params.prompt,
      buffer: "",
      sources: params.webSearch ? [] : null,
      searchWarning: null,
      startedAt: Date.now(),
      done: false,
      errors,
      abort: () => controller.abort(),
      pickedModel: null,
      ragChunks: null,
    };
    this.streams.set(params.sessionId, stream);
    this.notify();

    const update = (patch: Partial<LiveStream>) => {
      const cur = this.streams.get(params.sessionId);
      if (!cur) return;
      this.streams.set(params.sessionId, { ...cur, ...patch });
      this.notify();
    };

    streamChat(params.sessionId, params.prompt, {
      provider: params.provider,
      model: params.model ?? undefined,
      webSearch: params.webSearch,
      attachments: params.attachments,
      projectId: params.projectId ?? undefined,
      signal: controller.signal,
      onToken: (_p, delta) => {
        buffer += delta;
        update({ buffer });
      },
      onDone: () => {},
      onError: (_p, message) => {
        errors.push(message);
        buffer += `\n[error: ${message}]`;
        update({ buffer, errors: [...errors] });
      },
      onModel: (_p, name, reason) => {
        update({ pickedModel: { name, reason } });
      },
      onRag: (chunks) => {
        update({ ragChunks: chunks });
      },
      onSources: (sources, error) => {
        if (error && sources.length === 0) {
          // Total search failure — fold into the user-visible alert at end.
          errors.push(`web search: ${error}`);
          update({ sources, searchWarning: error });
        } else if (error) {
          // Partial failure (e.g., Google quota exceeded while Naver
          // returned hits): show inline in the sources box without
          // popping an alert at the end.
          update({ sources, searchWarning: error });
        } else {
          update({ sources });
        }
      },
    })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        // Abort initiated by the user via the Stop button isn't really an error.
        if (msg.toLowerCase().includes("abort")) return;
        errors.push(msg);
        buffer += `\n[error: ${msg}]`;
        update({ buffer, errors: [...errors] });
      })
      .finally(() => {
        update({ done: true });
        // We used to drop the entry from the map ~300ms after completion,
        // but that took the sources box (including the shopping
        // thumbnails) with it. Leave the LiveStream parked in the map
        // instead — it stays small, gets overwritten the next time
        // start() runs for this session, and lets ChatPanel keep the
        // sources visible alongside the now-persisted assistant message.
        params.onComplete?.(errors);
      });

    return true;
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }
}

export const streamStore = new StreamStore();

/**
 * React hook — re-renders when the named session's live stream changes.
 * Returns undefined when there is no in-flight stream.
 */
export function useLiveStream(sessionId: string | null): LiveStream | undefined {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => (sessionId ? streamStore.get(sessionId) : undefined),
    () => undefined
  );
}
