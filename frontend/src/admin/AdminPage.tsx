import { useCallback, useEffect, useMemo, useState } from "react";
import {
  admin,
  type AdminUser,
  type UserRole,
  type UserStatus,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";

interface Props {
  onBack: () => void;
}

type Tab = "pending" | "approved" | "rejected" | "all";

const TAB_LABELS: Record<Tab, string> = {
  pending: "승인 대기",
  approved: "활성",
  rejected: "반려",
  all: "전체",
};

const ROLE_LABELS: Record<UserRole, string> = {
  user: "일반",
  moderator: "운영자",
  admin: "관리자",
};

const STATUS_BADGE: Record<UserStatus, string> = {
  pending: "대기 중",
  approved: "활성",
  rejected: "반려",
};

export function AdminPage({ onBack }: Props) {
  const { user: me } = useAuth();
  const [tab, setTab] = useState<Tab>("pending");
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Rejection reason buffer keyed by user id — the textbox stays
  // open while the operator types, and resets after the action
  // completes.
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await admin.listUsers({
        status: tab === "all" ? undefined : tab,
        q: query.trim() || undefined,
      });
      setUsers(list);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.replace(/^\d+\s/, "")
          : "사용자 목록을 불러올 수 없습니다",
      );
    } finally {
      setLoading(false);
    }
  }, [tab, query]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const isAdmin = me?.role === "admin";

  async function withBusy(id: string, fn: () => Promise<void>) {
    setBusyId(id);
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error ? e.message.replace(/^\d+\s/, "") : "오류",
      );
    } finally {
      setBusyId(null);
    }
  }

  function patchUser(updated: AdminUser) {
    setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    // If the current tab no longer matches, drop the row from view.
    if (tab !== "all" && updated.status !== tab) {
      setUsers((prev) => prev.filter((u) => u.id !== updated.id));
    }
  }

  async function approve(u: AdminUser) {
    await withBusy(u.id, async () => {
      const updated = await admin.approve(u.id);
      patchUser(updated);
    });
  }

  async function reject(u: AdminUser) {
    await withBusy(u.id, async () => {
      const updated = await admin.reject(u.id, rejectReason.trim());
      patchUser(updated);
      setRejectFor(null);
      setRejectReason("");
    });
  }

  async function setRole(u: AdminUser, role: UserRole) {
    if (u.role === role) return;
    await withBusy(u.id, async () => {
      const updated = await admin.setRole(u.id, role);
      patchUser(updated);
    });
  }

  const counts = useMemo(() => {
    // For simplicity these are derived from the current page only —
    // the tab itself filters server-side, so the "pending" count is
    // the actual full count only when the pending tab is active.
    // Good enough for an in-list summary.
    const c = { pending: 0, approved: 0, rejected: 0, all: users.length };
    for (const u of users) {
      c[u.status] += 1;
    }
    return c;
  }, [users]);

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <button className="admin-back" onClick={onBack}>
          ← 뒤로
        </button>
        <h1>사용자 관리</h1>
        <p>가입 신청을 검토하고 권한을 부여합니다.</p>
      </header>

      <div className="admin-controls">
        <div className="admin-tabs" role="tablist">
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`admin-tab${tab === t ? " active" : ""}`}
              onClick={() => setTab(t)}
            >
              {TAB_LABELS[t]}
              {tab === t && t !== "all" && counts[t] > 0 && (
                <span className="admin-tab-count">{counts[t]}</span>
              )}
            </button>
          ))}
        </div>
        <input
          className="admin-search"
          type="search"
          placeholder="이메일 / 이름 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") refresh();
          }}
        />
        <button
          type="button"
          className="admin-refresh"
          onClick={refresh}
          disabled={loading}
        >
          {loading ? "로딩…" : "새로고침"}
        </button>
      </div>

      {error && <div className="admin-error">{error}</div>}

      {loading && users.length === 0 ? (
        <div className="admin-empty">불러오는 중…</div>
      ) : users.length === 0 ? (
        <div className="admin-empty">표시할 사용자가 없습니다.</div>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>사용자</th>
              <th>상태</th>
              <th>권한</th>
              <th>가입</th>
              <th className="admin-actions-col">작업</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={busyId === u.id ? "busy" : ""}>
                <td>
                  <div className="admin-user-name">{u.name || "(이름 없음)"}</div>
                  <div className="admin-user-email">{u.email}</div>
                  {u.rejection_reason && (
                    <div className="admin-user-reason">
                      사유: {u.rejection_reason}
                    </div>
                  )}
                </td>
                <td>
                  <span className={`admin-status admin-status-${u.status}`}>
                    {STATUS_BADGE[u.status]}
                  </span>
                </td>
                <td>
                  {isAdmin && u.id !== me?.id ? (
                    <select
                      className="admin-role-select"
                      value={u.role}
                      onChange={(e) => setRole(u, e.target.value as UserRole)}
                      disabled={busyId === u.id}
                    >
                      <option value="user">{ROLE_LABELS.user}</option>
                      <option value="moderator">{ROLE_LABELS.moderator}</option>
                      <option value="admin">{ROLE_LABELS.admin}</option>
                    </select>
                  ) : (
                    <span>{ROLE_LABELS[u.role]}</span>
                  )}
                </td>
                <td className="admin-cell-muted">
                  {new Date(u.created_at).toLocaleDateString()}
                </td>
                <td className="admin-actions-col">
                  {u.id === me?.id ? (
                    <span className="admin-cell-muted">— 본인</span>
                  ) : rejectFor === u.id ? (
                    <div className="admin-reject-row">
                      <input
                        type="text"
                        placeholder="반려 사유 (선택)"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        maxLength={500}
                        autoFocus
                      />
                      <button
                        className="admin-btn admin-btn-danger"
                        onClick={() => reject(u)}
                        disabled={busyId === u.id}
                      >
                        확인
                      </button>
                      <button
                        className="admin-btn"
                        onClick={() => {
                          setRejectFor(null);
                          setRejectReason("");
                        }}
                        disabled={busyId === u.id}
                      >
                        취소
                      </button>
                    </div>
                  ) : (
                    <div className="admin-actions">
                      {u.status !== "approved" && (
                        <button
                          className="admin-btn admin-btn-primary"
                          onClick={() => approve(u)}
                          disabled={busyId === u.id}
                        >
                          승인
                        </button>
                      )}
                      {u.status !== "rejected" && (
                        <button
                          className="admin-btn admin-btn-danger"
                          onClick={() => {
                            setRejectFor(u.id);
                            setRejectReason("");
                          }}
                          disabled={busyId === u.id}
                        >
                          반려
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
