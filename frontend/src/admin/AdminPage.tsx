import { useCallback, useEffect, useMemo, useState } from "react";
import {
  admin,
  type AdminUser,
  type AppSettings,
  type UserRole,
  type UserStatus,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";

interface Props {
  onBack: () => void;
}

type Tab = "pending" | "approved" | "suspended" | "rejected" | "all";

const TAB_LABELS: Record<Tab, string> = {
  pending: "승인 대기",
  approved: "활성",
  suspended: "정지",
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
  suspended: "정지",
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
  // Same pattern for the suspend action — separate buffer so opening
  // the suspend row doesn't clobber an in-progress reject reason.
  const [suspendFor, setSuspendFor] = useState<string | null>(null);
  const [suspendReason, setSuspendReason] = useState("");
  // Runtime app-policy snapshot (currently just the auto-approval
  // toggle). Loaded once on mount; admins can flip the switch and
  // the change is persisted server-side. Moderators see it but the
  // checkbox is disabled (admin-only mutation).
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);

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

  // Load the app-policy snapshot once on mount. We deliberately
  // keep this off the user-list refresh cycle — flipping it from
  // the dashboard updates state locally without re-fetching the
  // whole user table.
  useEffect(() => {
    admin
      .getSettings()
      .then(setAppSettings)
      .catch(() => {
        /* swallow — non-fatal; toggle just won't render. */
      });
  }, []);

  const isAdmin = me?.role === "admin";

  async function toggleAutoApprove(next: boolean) {
    if (!appSettings) return;
    setSettingsBusy(true);
    setError(null);
    // Optimistic — flip the UI immediately, roll back on failure.
    const prev = appSettings;
    setAppSettings({ ...appSettings, auto_approve_signups: next });
    try {
      const updated = await admin.updateSettings({
        auto_approve_signups: next,
      });
      setAppSettings(updated);
    } catch (e) {
      setAppSettings(prev);
      setError(
        e instanceof Error
          ? e.message.replace(/^\d+\s/, "")
          : "설정을 저장할 수 없습니다",
      );
    } finally {
      setSettingsBusy(false);
    }
  }

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

  async function suspend(u: AdminUser) {
    await withBusy(u.id, async () => {
      const updated = await admin.suspend(u.id, suspendReason.trim());
      patchUser(updated);
      setSuspendFor(null);
      setSuspendReason("");
    });
  }

  async function unsuspend(u: AdminUser) {
    await withBusy(u.id, async () => {
      const updated = await admin.unsuspend(u.id);
      patchUser(updated);
    });
  }

  // Last-admin guard at the UI level — purely advisory; the backend
  // is the source of truth. Used to dim the role dropdown / hide the
  // suspend button when demoting/suspending the last active admin
  // would lock the system out of policy controls.
  const activeAdminCount = useMemo(
    () =>
      users.filter((u) => u.role === "admin" && u.status === "approved").length,
    [users],
  );
  function wouldLeaveZeroAdmins(target: AdminUser): boolean {
    if (target.role !== "admin" || target.status !== "approved") return false;
    return activeAdminCount <= 1;
  }

  const counts = useMemo(() => {
    // For simplicity these are derived from the current page only —
    // the tab itself filters server-side, so the "pending" count is
    // the actual full count only when the pending tab is active.
    // Good enough for an in-list summary.
    const c = {
      pending: 0,
      approved: 0,
      suspended: 0,
      rejected: 0,
      all: users.length,
    };
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
        <h1>권한 관리</h1>
        <p>사용자의 권한을 부여·회수하고 가입 신청을 검토합니다.</p>
      </header>

      {appSettings && (
        <div className="admin-policy">
          <div className="admin-policy-text">
            <div className="admin-policy-title">
              자동 승인
              <span
                className={
                  "admin-policy-badge " +
                  (appSettings.auto_approve_signups
                    ? "admin-policy-badge-on"
                    : "admin-policy-badge-off")
                }
              >
                {appSettings.auto_approve_signups ? "켜짐" : "꺼짐"}
              </span>
            </div>
            <div className="admin-policy-sub">
              {appSettings.auto_approve_signups
                ? "새로 가입한 사용자가 즉시 활성화됩니다. (관리자 검토 불필요)"
                : "새 가입자는 ‘승인 대기’ 상태로 들어옵니다. 위 목록에서 승인하세요."}
            </div>
          </div>
          <label
            className={
              "admin-policy-switch" + (isAdmin ? "" : " disabled")
            }
            title={isAdmin ? undefined : "관리자(admin)만 변경할 수 있습니다"}
          >
            <input
              type="checkbox"
              checked={appSettings.auto_approve_signups}
              onChange={(e) => toggleAutoApprove(e.target.checked)}
              disabled={!isAdmin || settingsBusy}
            />
            <span className="admin-policy-slider" />
          </label>
        </div>
      )}

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
                  {u.signup_reason && (
                    <div className="admin-user-motive" title={u.signup_reason}>
                      <span className="admin-user-motive-label">가입 동기</span>{" "}
                      {u.signup_reason}
                    </div>
                  )}
                  {u.rejection_reason && (
                    <div className="admin-user-reason">
                      반려 사유: {u.rejection_reason}
                    </div>
                  )}
                  {u.suspension_reason && (
                    <div className="admin-user-reason">
                      정지 사유: {u.suspension_reason}
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
                      disabled={
                        busyId === u.id ||
                        // Last active admin: their role dropdown stays
                        // anchored to "admin" so a stray click can't
                        // strip the system of its only operator. The
                        // backend rejects this too, but pre-blocking
                        // avoids the round-trip error flash.
                        wouldLeaveZeroAdmins(u)
                      }
                      title={
                        wouldLeaveZeroAdmins(u)
                          ? "마지막 관리자입니다. 먼저 다른 사용자를 관리자로 승격하세요."
                          : undefined
                      }
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
                  ) : suspendFor === u.id ? (
                    <div className="admin-reject-row">
                      <input
                        type="text"
                        placeholder="정지 사유 (선택)"
                        value={suspendReason}
                        onChange={(e) => setSuspendReason(e.target.value)}
                        maxLength={500}
                        autoFocus
                      />
                      <button
                        className="admin-btn admin-btn-danger"
                        onClick={() => suspend(u)}
                        disabled={busyId === u.id}
                      >
                        확인
                      </button>
                      <button
                        className="admin-btn"
                        onClick={() => {
                          setSuspendFor(null);
                          setSuspendReason("");
                        }}
                        disabled={busyId === u.id}
                      >
                        취소
                      </button>
                    </div>
                  ) : (
                    <div className="admin-actions">
                      {u.status === "pending" && (
                        <button
                          className="admin-btn admin-btn-primary"
                          onClick={() => approve(u)}
                          disabled={busyId === u.id}
                        >
                          승인
                        </button>
                      )}
                      {u.status === "suspended" && (
                        <button
                          className="admin-btn admin-btn-primary"
                          onClick={() => unsuspend(u)}
                          disabled={busyId === u.id}
                        >
                          정지 해제
                        </button>
                      )}
                      {u.status === "approved" && (
                        <button
                          className="admin-btn admin-btn-danger"
                          onClick={() => {
                            setSuspendFor(u.id);
                            setSuspendReason("");
                          }}
                          disabled={
                            busyId === u.id ||
                            wouldLeaveZeroAdmins(u) ||
                            // Moderators can only suspend regular users
                            // — admin/moderator suspension is admin-only
                            // (backend enforces; this just hides the
                            // button so the moderator UI isn't busy).
                            (!isAdmin && u.role !== "user")
                          }
                          title={
                            wouldLeaveZeroAdmins(u)
                              ? "마지막 관리자입니다. 먼저 다른 사용자를 관리자로 승격하세요."
                              : !isAdmin && u.role !== "user"
                              ? "관리자/운영자 계정은 관리자(admin)만 정지할 수 있습니다"
                              : undefined
                          }
                        >
                          정지
                        </button>
                      )}
                      {u.status !== "rejected" && u.status !== "suspended" && (
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
