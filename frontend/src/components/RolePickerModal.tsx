import { useEffect, useMemo, useRef, useState } from "react";
import type { Role } from "../api/client";
import { IconCheck, IconSearch, IconX } from "./Icon";

interface Props {
  /** All assignable roles. Renders sorted, searchable, scrollable —
   *  designed for catalogs that may grow to ~100 codes. */
  roles: Role[];
  /** Initially-selected codes. The picker tracks edits internally;
   *  the parent only sees the final set on save. */
  initial: string[];
  /** Codes that must always render selected and aren't user-toggleable
   *  — e.g. the user's primary role is shown alongside extra grants so
   *  the operator can see the full effective set, but the picker for
   *  *additional* roles can't toggle it off here. */
  pinned?: string[];
  /** Multi-select (default) or single-select. */
  multiple?: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  onSave: (selected: string[]) => Promise<void> | void;
}

/** Generic role picker — used wherever we'd otherwise render a long
 *  flat checkbox grid of 100+ role codes. Search + grouping by
 *  base-role tier + virtualised height keep the popup usable; the
 *  parent saves the resulting code list on confirm. */
export function RolePickerModal({
  roles,
  initial,
  pinned = [],
  multiple = true,
  title,
  description,
  onClose,
  onSave,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initial),
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the search input on open so the operator can just start
  // typing to filter the catalog instead of hunting with the mouse.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = roles.slice().sort((a, b) => {
      // Selected + pinned at the top so the current state reads first;
      // then alphabetical so a long catalog scans predictably.
      const aSel = selected.has(a.code) || pinnedSet.has(a.code);
      const bSel = selected.has(b.code) || pinnedSet.has(b.code);
      if (aSel !== bSel) return aSel ? -1 : 1;
      return a.name.localeCompare(b.name, "ko");
    });
    if (!q) return list;
    return list.filter((r) => {
      return (
        r.code.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [roles, query, selected, pinnedSet]);

  function toggle(code: string) {
    if (pinnedSet.has(code)) return; // pinned can't be toggled
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) {
        next.delete(code);
      } else {
        if (!multiple) next.clear();
        next.add(code);
      }
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      // Pinned codes aren't user-toggleable but we still surface them
      // back so the saved set is the actual effective list.
      const out = Array.from(new Set([...selected, ...pinnedSet]));
      await onSave(out);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal role-picker-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="pm-head">
          <div className="pm-head-text">
            <h3>{title}</h3>
            {description && <p>{description}</p>}
          </div>
          <div className="pm-head-right">
            <button
              type="button"
              className="modal-close"
              onClick={onClose}
              aria-label="닫기"
            >
              <IconX size={18} />
            </button>
          </div>
        </header>

        <div className="role-picker-body">
          <div className="role-picker-search">
            <IconSearch size={14} />
            <input
              ref={inputRef}
              type="text"
              placeholder="역할 코드 / 이름 / 설명 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={busy}
            />
            {query && (
              <button
                type="button"
                className="role-picker-search-clear"
                onClick={() => setQuery("")}
                aria-label="지우기"
              >
                <IconX size={12} />
              </button>
            )}
          </div>
          <div className="role-picker-summary">
            <span>
              {selected.size + pinnedSet.size}개 선택됨
              {pinnedSet.size > 0 && ` (고정 ${pinnedSet.size}개 포함)`}
            </span>
            {multiple && selected.size > 0 && (
              <button
                type="button"
                className="role-picker-clear"
                onClick={() => setSelected(new Set())}
                disabled={busy}
              >
                모두 해제 (고정 제외)
              </button>
            )}
          </div>

          <ul className="role-picker-list">
            {filtered.length === 0 ? (
              <li className="role-picker-empty">
                일치하는 역할이 없습니다.
              </li>
            ) : (
              filtered.map((r) => {
                const isPinned = pinnedSet.has(r.code);
                const isSelected = selected.has(r.code) || isPinned;
                return (
                  <li
                    key={r.code}
                    className={`role-picker-row${
                      isSelected ? " selected" : ""
                    }${isPinned ? " pinned" : ""}`}
                  >
                    <button
                      type="button"
                      className="role-picker-row-btn"
                      onClick={() => toggle(r.code)}
                      disabled={busy || isPinned}
                      title={
                        isPinned
                          ? "기본 역할 — 여기서는 변경할 수 없습니다"
                          : undefined
                      }
                    >
                      <span
                        className={`role-picker-check${
                          isSelected ? " on" : ""
                        }`}
                        aria-hidden
                      >
                        {isSelected && <IconCheck size={11} />}
                      </span>
                      <span className="role-picker-row-text">
                        <span className="role-picker-row-name">
                          {r.name}
                          {isPinned && (
                            <span className="role-picker-pinned">기본</span>
                          )}
                        </span>
                        <span className="role-picker-row-meta">
                          <code>{r.code}</code>
                          <span className="role-picker-tier">
                            {r.base_role}
                          </span>
                          {r.description && (
                            <span className="role-picker-desc" title={r.description}>
                              {r.description}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>

          {err && (
            <div className="pm-add-error">
              <span>{err}</span>
            </div>
          )}

          <div className="role-picker-actions">
            <button
              type="button"
              className="pm-btn-secondary"
              onClick={onClose}
              disabled={busy}
            >
              취소
            </button>
            <button
              type="button"
              className="pm-btn-primary"
              onClick={save}
              disabled={busy}
            >
              {busy ? "저장 중…" : "저장"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
