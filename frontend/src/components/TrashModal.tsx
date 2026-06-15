import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Session } from "../types";

/** 휴지통 모달 (#31) — 삭제된 세션을 보고 복원 / 영구삭제.
 *  30일이 지나면 백엔드 부팅 시 자동 영구 삭제되지만, 사용자는 그
 *  전에 언제든 비울 수 있고 개별 복원도 가능. */
export function TrashModal({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged?: () => Promise<void> | void;
}) {
  const [rows, setRows] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const list = await api.listSessions(true);
      setRows(list);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, []);

  async function restore(id: string) {
    setBusyId(id);
    try {
      await api.restoreSession(id);
      await refresh();
      await onChanged?.();
    } catch (e) {
      window.alert(`복원 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }
  async function permanent(id: string) {
    if (!window.confirm("이 대화를 영구 삭제할까요? 되돌릴 수 없어요.")) return;
    setBusyId(id);
    try {
      await api.deleteSession(id, true);
      await refresh();
      await onChanged?.();
    } catch (e) {
      window.alert(`영구 삭제 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }
  async function emptyAll() {
    if (rows.length === 0) return;
    if (
      !window.confirm(
        `휴지통의 ${rows.length}개 대화를 모두 영구 삭제할까요?  되돌릴 수 없어요.`,
      )
    )
      return;
    try {
      await api.bulkSessions(
        rows.map((r) => r.id),
        "permanent-delete",
      );
      await refresh();
      await onChanged?.();
    } catch (e) {
      window.alert(`비우기 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className="trash-backdrop" onClick={onClose}>
      <div
        className="trash-modal"
        role="dialog"
        aria-label="휴지통"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="trash-head">
          <h3>🗑 휴지통</h3>
          <button type="button" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        <p className="trash-hint">
          30일 보관 후 자동 영구 삭제. 그 전에 언제든 복원할 수 있어요.
        </p>
        {err && <div className="trash-error">⚠ {err}</div>}
        {loading ? (
          <div className="trash-empty">불러오는 중…</div>
        ) : rows.length === 0 ? (
          <div className="trash-empty">휴지통이 비어 있어요.</div>
        ) : (
          <>
            <ul className="trash-list">
              {rows.map((s) => (
                <li key={s.id}>
                  <div className="trash-row-title">{s.title}</div>
                  <div className="trash-row-meta">
                    삭제: {s.deleted_at ? new Date(s.deleted_at).toLocaleString() : "—"}
                  </div>
                  <div className="trash-row-actions">
                    <button
                      type="button"
                      onClick={() => restore(s.id)}
                      disabled={busyId === s.id}
                    >
                      ↺ 복원
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => permanent(s.id)}
                      disabled={busyId === s.id}
                    >
                      영구 삭제
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="trash-foot">
              <button
                type="button"
                className="danger"
                onClick={emptyAll}
                disabled={rows.length === 0}
              >
                휴지통 비우기 ({rows.length}개)
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
