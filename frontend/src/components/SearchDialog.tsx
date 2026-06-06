import { useEffect, useMemo, useRef, useState } from "react";
import { api, type MessageSearchResult } from "../api/client";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called when the user picks a result. The parent navigates to
   *  the target session and tells ChatPanel which message to
   *  scroll/highlight via the second argument. */
  onPick: (sessionId: string, messageId: string) => void;
}

const ROLE_BADGE: Record<"user" | "assistant", { label: string; cls: string }> = {
  user: { label: "나", cls: "search-result-role-user" },
  assistant: { label: "AI", cls: "search-result-role-assistant" },
};

/** Modal global search across every message the user has authored
 *  or received. Opens on the chat header's 🔍 button or Cmd+K /
 *  Ctrl+K. Results are debounced — typing fast doesn't fire one
 *  request per keystroke. */
export function SearchDialog({ open, onClose, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MessageSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Highlighted result index for keyboard navigation (↑/↓/Enter).
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset every time the dialog opens — leaving stale results from
  // last session in view would look like the search ran on the new
  // open.
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setError(null);
      setCursor(0);
      // Slight delay so focus lands after the modal mounts.
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Debounced fetch — 220ms after the last keystroke. Empty / short
  // queries short-circuit to no-op so the server isn't pestered.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const handle = window.setTimeout(async () => {
      try {
        const rows = await api.searchMessages(q, 50);
        setResults(rows);
        setCursor(0);
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message.replace(/^\d+\s/, "")
            : "검색 실패",
        );
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => window.clearTimeout(handle);
  }, [query, open]);

  // Keep the focused result row in view as the cursor moves.
  useEffect(() => {
    if (!listRef.current) return;
    const row = listRef.current.querySelector<HTMLElement>(
      `[data-result-idx="${cursor}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // Highlight the query inside the snippet without rendering raw
  // HTML — splits on (case-insensitive) match boundaries and rebuilds
  // as React fragments. Avoids the XSS surface of dangerouslySet.
  const highlighted = useMemo(() => {
    const q = query.trim();
    if (!q) return (snippet: string) => [snippet] as (string | JSX.Element)[];
    const re = new RegExp(
      `(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "gi",
    );
    return (snippet: string) =>
      snippet.split(re).map((piece, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="search-hit-mark">
            {piece}
          </mark>
        ) : (
          piece
        ),
      );
  }, [query]);

  function commit(idx: number) {
    const r = results[idx];
    if (!r) return;
    onPick(r.session_id, r.message_id);
    onClose();
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(results.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(cursor);
    }
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop search-backdrop" onClick={onClose}>
      <div
        className="modal search-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKey}
      >
        <div className="search-input-row">
          <span className="search-input-icon" aria-hidden="true">
            🔍
          </span>
          <input
            ref={inputRef}
            type="search"
            className="search-input"
            placeholder="모든 채팅에서 메시지·파일명 검색 (2자 이상)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className="search-close"
            onClick={onClose}
            aria-label="검색 닫기"
            title="ESC"
          >
            ✕
          </button>
        </div>

        {error && <div className="search-error">{error}</div>}

        <div className="search-results" ref={listRef}>
          {loading && results.length === 0 && (
            <div className="search-empty">검색 중…</div>
          )}
          {!loading && query.trim().length >= 2 && results.length === 0 && (
            <div className="search-empty">일치하는 메시지가 없습니다.</div>
          )}
          {!loading && query.trim().length < 2 && (
            <div className="search-empty">
              검색어를 입력하세요. ↑↓로 이동, Enter로 열기.
            </div>
          )}
          {results.map((r, idx) => {
            const role = ROLE_BADGE[r.role];
            return (
              <button
                key={`${r.message_id}-${idx}`}
                type="button"
                data-result-idx={idx}
                className={`search-result${idx === cursor ? " active" : ""}`}
                onClick={() => commit(idx)}
                onMouseEnter={() => setCursor(idx)}
              >
                <div className="search-result-head">
                  <span className="search-result-title">
                    {r.session_title}
                  </span>
                  <span className={`search-result-role ${role.cls}`}>
                    {role.label}
                  </span>
                  <span className="search-result-time">
                    {new Date(r.created_at).toLocaleString()}
                  </span>
                </div>
                <div className="search-result-snippet">
                  {highlighted(r.snippet)}
                </div>
              </button>
            );
          })}
        </div>

        <div className="search-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> 이동</span>
          <span><kbd>Enter</kbd> 열기</span>
          <span><kbd>ESC</kbd> 닫기</span>
        </div>
      </div>
    </div>
  );
}
