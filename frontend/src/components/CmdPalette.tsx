import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { Session } from "../types";

/** 빠른 명령기 (#49) — Ctrl/⌘+Shift+P 로 띄움.
 *  세션·매크로·동작을 한 곳에서 검색하고 키보드만으로 실행.
 *  - 세션: 선택 시 chat:switch-session 디스패치
 *  - 매크로: 선택 시 chat:quote-pick 으로 본문 prefill
 *  - 동작: 미리 정의된 명령 (새 대화, 다크 모드 토글 등)
 */

type Item = {
  key: string;
  kind: "session" | "macro" | "sysmacro" | "action";
  label: string;
  hint?: string;
  onPick: () => void;
};

export function CmdPalette({
  sessions,
  onCreateChat,
  onClose,
}: {
  sessions: Session[];
  onCreateChat: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [macros, setMacros] = useState<{ id: string; name: string; body: string }[]>([]);
  const [sysMacros, setSysMacros] = useState<{ id: string; name: string; body: string }[]>([]);

  useEffect(() => {
    inputRef.current?.focus();
    api.listMacros().then(setMacros).catch(() => setMacros([]));
    api.listSystemMacros().then(setSysMacros).catch(() => setSysMacros([]));
  }, []);

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    // 동작 — 자주 쓰는 단축 명령.
    out.push({
      key: "act-new",
      kind: "action",
      label: "+ 새 대화",
      hint: "비어 있는 새 세션 시작",
      onPick: onCreateChat,
    });
    out.push({
      key: "act-theme",
      kind: "action",
      label: "🌓 테마 전환 (다크 ↔ 라이트)",
      hint: "data-theme 토글",
      onPick: () => {
        const cur = document.documentElement.getAttribute("data-theme");
        const next = cur === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        localStorage.setItem("chat:theme", next);
      },
    });
    out.push({
      key: "act-help",
      kind: "action",
      label: "? 단축키 도움말",
      onPick: () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }));
      },
    });
    // 세션 — 최근 30 개.
    for (const s of sessions.slice(0, 30)) {
      out.push({
        key: `s-${s.id}`,
        kind: "session",
        label: s.title,
        hint: new Date(s.updated_at).toLocaleDateString(),
        onPick: () => {
          window.dispatchEvent(
            new CustomEvent("chat:switch-session", {
              detail: { sessionId: s.id },
            }),
          );
        },
      });
    }
    // 시스템 매크로 (팀).
    for (const m of sysMacros) {
      out.push({
        key: `sm-${m.id}`,
        kind: "sysmacro",
        label: `/${m.name}`,
        hint: m.body.slice(0, 80),
        onPick: () => {
          window.dispatchEvent(
            new CustomEvent("chat:quote-pick", { detail: { text: m.body } }),
          );
        },
      });
    }
    // 개인 매크로.
    for (const m of macros) {
      out.push({
        key: `m-${m.id}`,
        kind: "macro",
        label: `/${m.name}`,
        hint: m.body.slice(0, 80),
        onPick: () => {
          window.dispatchEvent(
            new CustomEvent("chat:quote-pick", { detail: { text: m.body } }),
          );
        },
      });
    }
    return out;
  }, [sessions, macros, sysMacros, onCreateChat]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return items.slice(0, 30);
    return items
      .filter(
        (it) =>
          it.label.toLowerCase().includes(qq) ||
          (it.hint || "").toLowerCase().includes(qq),
      )
      .slice(0, 30);
  }, [items, q]);

  useEffect(() => {
    if (idx >= filtered.length) setIdx(0);
  }, [filtered, idx]);

  function activate(i: number) {
    const it = filtered[i];
    if (!it) return;
    it.onPick();
    onClose();
  }

  return (
    <div className="cmdpal-backdrop" onClick={onClose}>
      <div
        className="cmdpal"
        role="dialog"
        aria-label="빠른 명령"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmdpal-input"
          placeholder="세션·매크로·동작 검색…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              activate(idx);
            }
          }}
        />
        <ul className="cmdpal-list">
          {filtered.length === 0 ? (
            <li className="cmdpal-empty">일치하는 항목 없음</li>
          ) : (
            filtered.map((it, i) => (
              <li
                key={it.key}
                className={`cmdpal-item${i === idx ? " active" : ""}`}
                onMouseEnter={() => setIdx(i)}
                onClick={() => activate(i)}
              >
                <span className={`cmdpal-kind cmdpal-kind-${it.kind}`}>
                  {it.kind === "session"
                    ? "💬"
                    : it.kind === "macro"
                      ? "⌨"
                      : it.kind === "sysmacro"
                        ? "👥"
                        : "⚡"}
                </span>
                <span className="cmdpal-label">{it.label}</span>
                {it.hint && <span className="cmdpal-hint">{it.hint}</span>}
              </li>
            ))
          )}
        </ul>
        <div className="cmdpal-foot">
          ↑↓ 이동 · Enter 실행 · Esc 닫기
        </div>
      </div>
    </div>
  );
}
