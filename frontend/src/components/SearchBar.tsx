import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, type MessageSearchResult } from "../api/client";
import type { Session } from "../types";
import { IconChat, IconFileText, IconSearch } from "./Icon";

interface Props {
  /** All sessions the user owns — searched locally for the "세션"
   *  section so that subset of the dropdown lights up without a
   *  network call. */
  sessions: Session[];
  onPick: (sessionId: string, messageId: string | null) => void;
}

export interface SearchBarHandle {
  /** Focus the input — called by App when the global Ctrl/⌘K
   *  shortcut fires so the user can search from anywhere. */
  focus: () => void;
}

type Section = "all" | "session" | "message" | "attachment";

const SECTION_LABEL: Record<Exclude<Section, "all">, string> = {
  session: "세션",
  message: "메시지",
  attachment: "첨부 파일",
};

const ROLE_BADGE: Record<
  "user" | "assistant",
  { label: string; cls: string }
> = {
  user: { label: "나", cls: "search-result-role-user" },
  assistant: { label: "AI", cls: "search-result-role-assistant" },
};

interface FlatRow {
  kind: "session" | "message" | "attachment";
  key: string;
  sessionId: string;
  messageId: string | null;
  title: string;
  subtitle: string;
  role?: "user" | "assistant";
  timestamp?: string;
}

/** Persistent global-search input mounted in the top header strip,
 *  on the same row as the user-menu avatar. The dropdown panel
 *  drops down beneath the input only while it has focus AND a
 *  non-trivial query, so it doesn't shove the layout around in the
 *  empty state. */
export const SearchBar = forwardRef<SearchBarHandle, Props>(function SearchBar(
  { sessions, onPick },
  ref,
) {
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<Section>("all");
  const [focused, setFocused] = useState(false);
  const [results, setResults] = useState<MessageSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  }));

  // Click-away handler — close the dropdown when the focus leaves
  // the whole wrap (not just the input, since results live in the
  // same wrap and shouldn't dismiss the panel on click).
  useEffect(() => {
    if (!focused) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setFocused(false);
      }
    }
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [focused]);

  // Debounced server search (220ms after last keystroke).
  useEffect(() => {
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
        const rows = await api.searchMessages(q, 80);
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
  }, [query]);

  const sessionHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [] as Session[];
    return sessions
      .filter((s) => s.title.toLowerCase().includes(q))
      .slice(0, 12);
  }, [sessions, query]);

  const messageHits = useMemo(
    () => results.filter((r) => r.match_in === "content"),
    [results],
  );
  const attachmentHits = useMemo(
    () => results.filter((r) => r.match_in === "attachment"),
    [results],
  );

  const rows: FlatRow[] = useMemo(() => {
    const out: FlatRow[] = [];
    if (section === "all" || section === "session") {
      for (const s of sessionHits) {
        out.push({
          kind: "session",
          key: `s-${s.id}`,
          sessionId: s.id,
          messageId: null,
          title: s.title || "(제목 없음)",
          subtitle: new Date(s.updated_at).toLocaleString(),
        });
      }
    }
    if (section === "all" || section === "message") {
      for (const r of messageHits) {
        out.push({
          kind: "message",
          key: `m-${r.message_id}`,
          sessionId: r.session_id,
          messageId: r.message_id,
          title: r.session_title,
          subtitle: r.snippet,
          role: r.role,
          timestamp: r.created_at,
        });
      }
    }
    if (section === "all" || section === "attachment") {
      for (const r of attachmentHits) {
        out.push({
          kind: "attachment",
          key: `a-${r.message_id}`,
          sessionId: r.session_id,
          messageId: r.message_id,
          title: r.session_title,
          subtitle: r.snippet,
          role: r.role,
          timestamp: r.created_at,
        });
      }
    }
    return out;
  }, [section, sessionHits, messageHits, attachmentHits]);

  useEffect(() => {
    setCursor(0);
  }, [section, rows.length]);

  const highlighted = useMemo(() => {
    const q = query.trim();
    if (!q) return (s: string) => [s] as (string | JSX.Element)[];
    const re = new RegExp(
      `(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "gi",
    );
    return (s: string) =>
      s.split(re).map((piece, i) =>
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
    const r = rows[idx];
    if (!r) return;
    onPick(r.sessionId, r.messageId);
    setQuery("");
    setFocused(false);
    inputRef.current?.blur();
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      if (query) {
        setQuery("");
      } else {
        setFocused(false);
        inputRef.current?.blur();
      }
      return;
    }
    if (rows.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(rows.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(cursor);
    }
  }

  const showPanel = focused && query.trim().length >= 2;
  const totalCount =
    sessionHits.length + messageHits.length + attachmentHits.length;
  const counts: Record<Section, number> = {
    all: totalCount,
    session: sessionHits.length,
    message: messageHits.length,
    attachment: attachmentHits.length,
  };

  let messageStart = sessionHits.length;
  let attachmentStart = messageStart + messageHits.length;
  if (section !== "all") {
    messageStart = 0;
    attachmentStart = 0;
  }

  function renderRow(r: FlatRow, idx: number) {
    const role = r.role ? ROLE_BADGE[r.role] : null;
    return (
      <button
        key={r.key}
        type="button"
        data-row-idx={idx}
        className={`search-result${idx === cursor ? " active" : ""}`}
        onMouseDown={(e) => {
          // Prevent the input from losing focus before the click
          // handler resolves, otherwise the panel hides first.
          e.preventDefault();
        }}
        onClick={() => commit(idx)}
        onMouseEnter={() => setCursor(idx)}
      >
        <div className="search-result-icon" aria-hidden="true">
          {r.kind === "attachment" ? (
            <IconFileText size={14} />
          ) : (
            <IconChat size={14} />
          )}
        </div>
        <div className="search-result-body">
          <div className="search-result-head">
            <span className="search-result-title">
              {r.kind === "session" ? highlighted(r.title) : r.title}
            </span>
            {role && (
              <span className={`search-result-role ${role.cls}`}>
                {role.label}
              </span>
            )}
            {r.timestamp && (
              <span className="search-result-time">
                {new Date(r.timestamp).toLocaleString()}
              </span>
            )}
            {!r.timestamp && r.subtitle && (
              <span className="search-result-time">{r.subtitle}</span>
            )}
          </div>
          {r.kind !== "session" && (
            <div className="search-result-snippet">
              {highlighted(r.subtitle)}
            </div>
          )}
        </div>
      </button>
    );
  }

  return (
    <div className="searchbar" ref={wrapRef}>
      <div className="searchbar-input-wrap">
        <span className="searchbar-icon" aria-hidden="true">
          <IconSearch size={14} />
        </span>
        <input
          ref={inputRef}
          type="search"
          className="searchbar-input"
          placeholder="통합 검색 (메시지·세션·첨부)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={handleKey}
        />
        {query && (
          <button
            type="button"
            className="searchbar-clear"
            aria-label="검색어 지우기"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setQuery("")}
          >
            ✕
          </button>
        )}
      </div>

      {showPanel && (
        <div className="searchbar-panel">
          <div className="search-chips">
            {(["all", "session", "message", "attachment"] as Section[]).map(
              (s) => {
                const label = s === "all" ? "전체" : SECTION_LABEL[s];
                return (
                  <button
                    key={s}
                    type="button"
                    className={`search-chip${section === s ? " active" : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setSection(s)}
                  >
                    {label}
                    <span className="search-chip-count">{counts[s]}</span>
                  </button>
                );
              },
            )}
          </div>

          {error && <div className="search-error">{error}</div>}

          <div className="search-results">
            {loading && rows.length === 0 && (
              <div className="search-empty">검색 중…</div>
            )}
            {!loading && rows.length === 0 && (
              <div className="search-empty">일치하는 항목이 없습니다.</div>
            )}

            {section === "all" ? (
              <>
                {sessionHits.length > 0 && (
                  <div className="search-section-head">
                    세션{" "}
                    <span className="search-section-count">
                      {sessionHits.length}
                    </span>
                  </div>
                )}
                {rows
                  .slice(0, sessionHits.length)
                  .map((r, i) => renderRow(r, i))}
                {messageHits.length > 0 && (
                  <div className="search-section-head">
                    메시지{" "}
                    <span className="search-section-count">
                      {messageHits.length}
                    </span>
                  </div>
                )}
                {rows
                  .slice(messageStart, messageStart + messageHits.length)
                  .map((r, i) => renderRow(r, messageStart + i))}
                {attachmentHits.length > 0 && (
                  <div className="search-section-head">
                    첨부 파일{" "}
                    <span className="search-section-count">
                      {attachmentHits.length}
                    </span>
                  </div>
                )}
                {rows
                  .slice(attachmentStart, attachmentStart + attachmentHits.length)
                  .map((r, i) => renderRow(r, attachmentStart + i))}
              </>
            ) : (
              rows.map((r, i) => renderRow(r, i))
            )}
          </div>
        </div>
      )}
    </div>
  );
});
