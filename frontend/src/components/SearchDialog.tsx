import { useEffect, useMemo, useRef, useState } from "react";
import { api, type MessageSearchResult } from "../api/client";
import type { Session } from "../types";
import { IconChat, IconFileText, IconSearch } from "./Icon";

interface Props {
  open: boolean;
  onClose: () => void;
  /** All sessions of the current user — searched locally by title
   *  so the "세션" section in the dialog populates instantly without
   *  another round-trip. */
  sessions: Session[];
  /** Result picker. messageId may be null when the user picked a
   *  session row (no specific message to scroll to). */
  onPick: (sessionId: string, messageId: string | null) => void;
}

const ROLE_BADGE: Record<
  "user" | "assistant",
  { label: string; cls: string }
> = {
  user: { label: "나", cls: "search-result-role-user" },
  assistant: { label: "AI", cls: "search-result-role-assistant" },
};

type Section = "all" | "session" | "message" | "attachment";

const SECTION_LABEL: Record<Exclude<Section, "all">, string> = {
  session: "세션",
  message: "메시지",
  attachment: "첨부 파일",
};

interface FlatRow {
  kind: "session" | "message" | "attachment";
  key: string;
  // Click target
  sessionId: string;
  messageId: string | null;
  // Render
  title: string;
  subtitle: string;
  role?: "user" | "assistant";
  timestamp?: string;
}

/** Korean-portal-style global search modal — single sticky input at
 *  the top, results below grouped into 세션 / 메시지 / 첨부 파일
 *  sections. Active section chip filters the list while keeping the
 *  same query. Click jumps to the target (and, for messages, asks
 *  the parent to scroll-into-view + flash highlight). */
export function SearchDialog({ open, onClose, sessions, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<Section>("all");
  const [results, setResults] = useState<MessageSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSection("all");
      setResults([]);
      setError(null);
      setCursor(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

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
  }, [query, open]);

  // Sessions matched locally by title — fast, no network.
  const sessionHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [] as Session[];
    return sessions.filter((s) => s.title.toLowerCase().includes(q)).slice(0, 12);
  }, [sessions, query]);

  const messageHits = useMemo(
    () => results.filter((r) => r.match_in === "content"),
    [results],
  );
  const attachmentHits = useMemo(
    () => results.filter((r) => r.match_in === "attachment"),
    [results],
  );

  // Flat row list in display order — kept in sync with `section` chip
  // so keyboard ↑↓ navigation and Enter target the visible subset only.
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

  useEffect(() => {
    if (!listRef.current) return;
    const row = listRef.current.querySelector<HTMLElement>(
      `[data-row-idx="${cursor}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

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
    onClose();
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
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

  if (!open) return null;

  const totalCount = sessionHits.length + messageHits.length + attachmentHits.length;
  const counts: Record<Section, number> = {
    all: totalCount,
    session: sessionHits.length,
    message: messageHits.length,
    attachment: attachmentHits.length,
  };

  // Split rows back into sections for headered rendering when the
  // 전체 chip is active. The flat `rows` list is what cursor/idx is
  // measured against; this is purely for visual section headers.
  let sessionStart = 0;
  let messageStart = sessionStart;
  let attachmentStart = messageStart;
  if (section === "all") {
    messageStart = sessionHits.length;
    attachmentStart = messageStart + messageHits.length;
  }

  function renderRow(r: FlatRow, idx: number) {
    const role = r.role ? ROLE_BADGE[r.role] : null;
    return (
      <button
        key={r.key}
        type="button"
        data-row-idx={idx}
        className={`search-result${idx === cursor ? " active" : ""}`}
        onClick={() => commit(idx)}
        onMouseEnter={() => setCursor(idx)}
      >
        <div className="search-result-icon" aria-hidden="true">
          {r.kind === "session" ? (
            <IconChat size={14} />
          ) : r.kind === "attachment" ? (
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
    <div className="modal-backdrop search-backdrop" onClick={onClose}>
      <div
        className="modal search-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKey}
      >
        <div className="search-input-row">
          <span className="search-input-icon" aria-hidden="true">
            <IconSearch size={18} />
          </span>
          <input
            ref={inputRef}
            type="search"
            className="search-input"
            placeholder="통합 검색 — 세션 제목·메시지·첨부 파일명까지 한 번에"
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

        <div className="search-chips">
          {(["all", "session", "message", "attachment"] as Section[]).map((s) => {
            const label = s === "all" ? "전체" : SECTION_LABEL[s];
            const n = counts[s];
            return (
              <button
                key={s}
                type="button"
                className={`search-chip${section === s ? " active" : ""}`}
                onClick={() => setSection(s)}
                disabled={query.trim().length < 2}
              >
                {label}
                {query.trim().length >= 2 && (
                  <span className="search-chip-count">{n}</span>
                )}
              </button>
            );
          })}
        </div>

        {error && <div className="search-error">{error}</div>}

        <div className="search-results" ref={listRef}>
          {loading && rows.length === 0 && (
            <div className="search-empty">검색 중…</div>
          )}
          {!loading && query.trim().length < 2 && (
            <div className="search-empty">
              검색어를 입력하세요 (2자 이상). <kbd>↑</kbd><kbd>↓</kbd> 이동 ·
              <kbd>Enter</kbd> 열기 · <kbd>ESC</kbd> 닫기
            </div>
          )}
          {!loading && query.trim().length >= 2 && rows.length === 0 && (
            <div className="search-empty">일치하는 항목이 없습니다.</div>
          )}

          {section === "all" ? (
            <>
              {sessionHits.length > 0 && (
                <div className="search-section-head">
                  세션 <span className="search-section-count">{sessionHits.length}</span>
                </div>
              )}
              {rows.slice(0, sessionHits.length).map((r, i) => renderRow(r, i))}
              {messageHits.length > 0 && (
                <div className="search-section-head">
                  메시지 <span className="search-section-count">{messageHits.length}</span>
                </div>
              )}
              {rows
                .slice(messageStart, messageStart + messageHits.length)
                .map((r, i) => renderRow(r, messageStart + i))}
              {attachmentHits.length > 0 && (
                <div className="search-section-head">
                  첨부 파일 <span className="search-section-count">{attachmentHits.length}</span>
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
    </div>
  );
}
