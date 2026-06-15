import { useCallback, useEffect, useMemo, useState } from "react";
import {
  admin,
  api,
  type AdminUser,
  type AppSettings,
  type BuiltinRole,
  type Project,
  type Role,
  type UserRole,
  type UserStatus,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { IconCheck, IconPlus, IconX } from "../components/Icon";
import { ProjectModal } from "../components/ProjectModal";
import { RolePickerModal } from "../components/RolePickerModal";
import { useProjects } from "../state/ProjectsContext";

interface Props {
  onBack: () => void;
}

type View = "users" | "roles" | "knowledge" | "errors" | "audit" | "sessions" | "ops" | "quality" | "usage";

type Tab = "pending" | "approved" | "suspended" | "rejected" | "all";

const VIEW_LABELS: Record<View, string> = {
  users: "사용자",
  roles: "역할 코드",
  knowledge: "지식베이스",
  errors: "오류 모니터링",
  quality: "답변 품질",
  usage: "사용량",
  audit: "감사 로그",
  sessions: "활성 세션",
  ops: "운영 대시보드",
};

const TAB_LABELS: Record<Tab, string> = {
  pending: "승인 대기",
  approved: "활성",
  suspended: "정지",
  rejected: "반려",
  all: "전체",
};

const STATUS_BADGE: Record<UserStatus, string> = {
  pending: "대기 중",
  approved: "활성",
  suspended: "정지",
  rejected: "반려",
};

const BASE_ROLE_BADGE: Record<BuiltinRole, string> = {
  admin: "관리자 권한",
  moderator: "운영자 권한",
  user: "일반 권한",
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
  // Top-level view selector — splits the existing user-list UI from
  // the new "역할 코드" management screen so the page stays single-
  // file but doesn't bury either feature.
  const [view, setView] = useState<View>("users");
  // Role catalog — populates the user-row dropdown (so custom codes
  // show up) and powers the entire roles management view.
  const [roles, setRoles] = useState<Role[]>([]);
  const roleLabel = useCallback(
    (code: string) => {
      const found = roles.find((r) => r.code === code);
      return found ? found.name : code;
    },
    [roles],
  );

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

  const refreshRoles = useCallback(async () => {
    try {
      const list = await admin.listRoles();
      setRoles(list);
    } catch {
      // Non-fatal — the user list still renders without role labels;
      // the dropdown just shows the raw code as a fallback.
    }
  }, []);

  useEffect(() => {
    refreshRoles();
  }, [refreshRoles]);

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

  /** Open the additional-roles picker for a user. Tracked at page
   *  level so the modal sits outside the table row (which would
   *  re-render on every patch). */
  const [rolesPickerFor, setRolesPickerFor] = useState<AdminUser | null>(null);
  async function saveExtraRoles(roleCodes: string[]) {
    if (!rolesPickerFor) return;
    const u = rolesPickerFor;
    await withBusy(u.id, async () => {
      // Strip the primary role server-side too, but pre-filter so the
      // payload doesn't pretend to grant it twice.
      const extras = roleCodes.filter((c) => c !== u.role);
      const updated = await admin.setUserRoles(u.id, extras);
      patchUser(updated);
    });
    setRolesPickerFor(null);
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

  // Resolve a role code → effective tier via the loaded role catalog,
  // falling back to "user" when the code isn't in the table yet.
  // Powers the last-admin guard so custom admin-tier codes also count.
  function baseRoleOf(code: string): BuiltinRole {
    if (code === "admin" || code === "moderator" || code === "user") {
      return code;
    }
    const found = roles.find((r) => r.code === code);
    return found?.base_role ?? "user";
  }

  // Last-admin guard at the UI level — purely advisory; the backend
  // is the source of truth. Counts anyone whose effective tier is
  // admin (built-in or custom code with base_role='admin').
  const activeAdminCount = useMemo(
    () =>
      users.filter(
        (u) => baseRoleOf(u.role) === "admin" && u.status === "approved",
      ).length,
    [users, roles],
  );
  function wouldLeaveZeroAdmins(target: AdminUser): boolean {
    if (baseRoleOf(target.role) !== "admin") return false;
    if (target.status !== "approved") return false;
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
        <div className="admin-header-top">
          <button className="admin-back" onClick={onBack}>
            ← 뒤로
          </button>
          <HealthIndicator />
        </div>
        <h1>권한 관리</h1>
        <p>사용자의 권한을 부여·회수하고 가입 신청을 검토합니다.</p>
        <div className="admin-view-tabs">
          {(Object.keys(VIEW_LABELS) as View[]).map((v) => (
            <button
              key={v}
              type="button"
              className={`admin-view-tab${view === v ? " active" : ""}`}
              onClick={() => setView(v)}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
      </header>

      {view === "roles" && (
        <RolesPanel
          roles={roles}
          users={users}
          isAdmin={isAdmin}
          onChanged={refreshRoles}
        />
      )}

      {view === "knowledge" && <KnowledgePanel isAdmin={isAdmin} />}

      {view === "errors" && <ErrorsPanel />}
      {view === "quality" && <QualityPanel />}
      {view === "usage" && <UsagePanel />}
      {view === "audit" && <AuditPanel />}
      {view === "sessions" && <ActiveSessionsPanel />}
      {view === "ops" && <OpsDashboardPanel />}

      {view === "users" && appSettings && (
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

      {view === "users" && (
      <>
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
                  <div className="admin-user-email">
                    {u.email}
                    <span
                      className={
                        "admin-user-verified " +
                        (u.email_verified
                          ? "admin-user-verified-yes"
                          : "admin-user-verified-no")
                      }
                      title={
                        u.email_verified
                          ? "이메일 인증 완료"
                          : "이메일 인증이 아직 완료되지 않았습니다"
                      }
                    >
                      {u.email_verified ? (
                        <>
                          <IconCheck size={11} /> 인증
                        </>
                      ) : (
                        <>
                          <IconX size={11} /> 미인증
                        </>
                      )}
                    </span>
                  </div>
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
                  <div className="role-chip-stack">
                    {isAdmin && u.id !== me?.id ? (
                      <select
                        className="admin-role-select"
                        value={u.role}
                        onChange={(e) =>
                          setRole(u, e.target.value as UserRole)
                        }
                        disabled={
                          busyId === u.id || wouldLeaveZeroAdmins(u)
                        }
                        title={
                          wouldLeaveZeroAdmins(u)
                            ? "마지막 관리자입니다. 먼저 다른 사용자를 관리자로 승격하세요."
                            : "기본 역할"
                        }
                      >
                        {roles.length === 0 ? (
                          <>
                            <option value="user">일반</option>
                            <option value="moderator">운영자</option>
                            <option value="admin">관리자</option>
                          </>
                        ) : (
                          roles.map((r) => (
                            <option key={r.code} value={r.code}>
                              {r.name}
                              {!r.is_system ? ` (${r.code})` : ""}
                            </option>
                          ))
                        )}
                      </select>
                    ) : (
                      <span className="role-chip primary">
                        {roleLabel(u.role)}
                      </span>
                    )}
                    {(u.extra_roles ?? []).map((code) => (
                      <span key={code} className="role-chip">
                        {roleLabel(code)}
                      </span>
                    ))}
                    {isAdmin && (
                      <button
                        type="button"
                        className="role-chip-edit"
                        onClick={() => setRolesPickerFor(u)}
                        disabled={busyId === u.id}
                        title="추가 역할 편집"
                      >
                        <IconPlus size={10} />
                        {(u.extra_roles ?? []).length > 0
                          ? "편집"
                          : "역할 추가"}
                      </button>
                    )}
                  </div>
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
      </>
      )}

      {rolesPickerFor && (
        <RolePickerModal
          roles={roles}
          initial={rolesPickerFor.extra_roles ?? []}
          pinned={[rolesPickerFor.role]}
          multiple
          title={`${rolesPickerFor.name || rolesPickerFor.email} 의 역할`}
          description="기본 역할(고정) 외에 부여할 추가 역할을 선택하세요. 사용자는 모든 선택된 역할의 권한을 함께 가집니다."
          onClose={() => setRolesPickerFor(null)}
          onSave={saveExtraRoles}
        />
      )}
    </div>
  );
}


function RolesPanel({
  roles,
  users,
  isAdmin,
  onChanged,
}: {
  roles: Role[];
  users: AdminUser[];
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{
    code: string;
    name: string;
    description: string;
    base_role: BuiltinRole;
  }>({ code: "", name: "", description: "", base_role: "user" });
  // Per-row edit buffers — keyed by code so multiple rows can be open
  // simultaneously without state collisions.
  const [editing, setEditing] = useState<
    Record<string, { name: string; description: string; base_role: BuiltinRole }>
  >({});

  const userCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const u of users) {
      m[u.role] = (m[u.role] ?? 0) + 1;
    }
    return m;
  }, [users]);

  async function create() {
    if (!isAdmin) return;
    setError(null);
    if (!draft.code.trim() || !draft.name.trim()) {
      setError("코드와 이름을 입력하세요.");
      return;
    }
    setBusy("__new__");
    try {
      await admin.createRole({
        code: draft.code.trim().toLowerCase(),
        name: draft.name.trim(),
        description: draft.description.trim(),
        base_role: draft.base_role,
      });
      setDraft({ code: "", name: "", description: "", base_role: "user" });
      setAdding(false);
      onChanged();
    } catch (e) {
      setError(
        e instanceof Error ? e.message.replace(/^\d+\s/, "") : "역할 생성 실패",
      );
    } finally {
      setBusy(null);
    }
  }

  async function save(code: string) {
    if (!isAdmin) return;
    const buf = editing[code];
    if (!buf) return;
    setBusy(code);
    setError(null);
    try {
      await admin.updateRole(code, {
        name: buf.name.trim(),
        description: buf.description.trim(),
        base_role: buf.base_role,
      });
      setEditing((prev) => {
        const next = { ...prev };
        delete next[code];
        return next;
      });
      onChanged();
    } catch (e) {
      setError(
        e instanceof Error ? e.message.replace(/^\d+\s/, "") : "저장 실패",
      );
    } finally {
      setBusy(null);
    }
  }

  async function remove(code: string) {
    if (!isAdmin) return;
    if (!window.confirm(`'${code}' 역할을 삭제하시겠어요?`)) return;
    setBusy(code);
    setError(null);
    try {
      await admin.deleteRole(code);
      onChanged();
    } catch (e) {
      setError(
        e instanceof Error ? e.message.replace(/^\d+\s/, "") : "삭제 실패",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="admin-roles">
      <div className="admin-roles-head">
        <div>
          <h2>역할 코드</h2>
          <p>
            기본 3개(관리자/운영자/일반) 외에 운영 상황에 맞는 커스텀 역할을
            정의할 수 있습니다. base 권한 등급에 따라 권한 체크가 동작합니다.
          </p>
        </div>
        {isAdmin && !adding && (
          <button
            type="button"
            className="admin-btn admin-btn-primary"
            onClick={() => setAdding(true)}
          >
            새 역할 추가
          </button>
        )}
      </div>

      {error && <div className="admin-error">{error}</div>}

      {adding && (
        <div className="admin-role-add">
          <div className="admin-role-add-grid">
            <label>
              <span>코드</span>
              <input
                type="text"
                value={draft.code}
                onChange={(e) =>
                  setDraft({ ...draft, code: e.target.value.toLowerCase() })
                }
                placeholder="예: editor"
                pattern="[a-z][a-z0-9_\-]*"
                maxLength={40}
              />
            </label>
            <label>
              <span>이름</span>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="예: 에디터"
                maxLength={80}
              />
            </label>
            <label>
              <span>base 권한</span>
              <select
                value={draft.base_role}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    base_role: e.target.value as BuiltinRole,
                  })
                }
              >
                <option value="user">일반 권한</option>
                <option value="moderator">운영자 권한</option>
                <option value="admin">관리자 권한</option>
              </select>
            </label>
            <label className="admin-role-add-desc">
              <span>설명</span>
              <input
                type="text"
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
                placeholder="이 역할이 하는 일을 한 줄로"
                maxLength={500}
              />
            </label>
          </div>
          <div className="admin-role-add-actions">
            <button
              type="button"
              className="admin-btn admin-btn-primary"
              onClick={create}
              disabled={busy === "__new__"}
            >
              {busy === "__new__" ? "추가 중…" : "추가"}
            </button>
            <button
              type="button"
              className="admin-btn"
              onClick={() => {
                setAdding(false);
                setDraft({
                  code: "",
                  name: "",
                  description: "",
                  base_role: "user",
                });
              }}
              disabled={busy === "__new__"}
            >
              취소
            </button>
          </div>
        </div>
      )}

      <table className="admin-table">
        <thead>
          <tr>
            <th>코드</th>
            <th>이름</th>
            <th>설명</th>
            <th>base 권한</th>
            <th>사용 중</th>
            <th className="admin-actions-col">작업</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => {
            const buf = editing[r.code];
            const inEdit = !!buf;
            const baseLabel = BASE_ROLE_BADGE[r.base_role];
            return (
              <tr key={r.code} className={busy === r.code ? "busy" : ""}>
                <td>
                  <code className="admin-role-code">{r.code}</code>
                  {r.is_system && (
                    <span className="admin-role-system">시스템</span>
                  )}
                </td>
                <td>
                  {inEdit ? (
                    <input
                      type="text"
                      value={buf.name}
                      onChange={(e) =>
                        setEditing((prev) => ({
                          ...prev,
                          [r.code]: { ...buf, name: e.target.value },
                        }))
                      }
                      maxLength={80}
                    />
                  ) : (
                    r.name
                  )}
                </td>
                <td className="admin-role-desc">
                  {inEdit ? (
                    <input
                      type="text"
                      value={buf.description}
                      onChange={(e) =>
                        setEditing((prev) => ({
                          ...prev,
                          [r.code]: { ...buf, description: e.target.value },
                        }))
                      }
                      maxLength={500}
                    />
                  ) : (
                    r.description || (
                      <span className="admin-cell-muted">—</span>
                    )
                  )}
                </td>
                <td>
                  {inEdit && !r.is_system ? (
                    <select
                      value={buf.base_role}
                      onChange={(e) =>
                        setEditing((prev) => ({
                          ...prev,
                          [r.code]: {
                            ...buf,
                            base_role: e.target.value as BuiltinRole,
                          },
                        }))
                      }
                    >
                      <option value="user">일반 권한</option>
                      <option value="moderator">운영자 권한</option>
                      <option value="admin">관리자 권한</option>
                    </select>
                  ) : (
                    <span className={`admin-role-base base-${r.base_role}`}>
                      {baseLabel}
                    </span>
                  )}
                </td>
                <td className="admin-cell-muted">
                  {userCount[r.code] ?? 0}명
                </td>
                <td className="admin-actions-col">
                  {!isAdmin ? (
                    <span className="admin-cell-muted">읽기 전용</span>
                  ) : inEdit ? (
                    <div className="admin-actions">
                      <button
                        className="admin-btn admin-btn-primary"
                        onClick={() => save(r.code)}
                        disabled={busy === r.code}
                      >
                        저장
                      </button>
                      <button
                        className="admin-btn"
                        onClick={() =>
                          setEditing((prev) => {
                            const next = { ...prev };
                            delete next[r.code];
                            return next;
                          })
                        }
                        disabled={busy === r.code}
                      >
                        취소
                      </button>
                    </div>
                  ) : (
                    <div className="admin-actions">
                      <button
                        className="admin-btn"
                        onClick={() =>
                          setEditing((prev) => ({
                            ...prev,
                            [r.code]: {
                              name: r.name,
                              description: r.description || "",
                              base_role: r.base_role,
                            },
                          }))
                        }
                      >
                        편집
                      </button>
                      {!r.is_system && (
                        <button
                          className="admin-btn admin-btn-danger"
                          onClick={() => remove(r.code)}
                          disabled={(userCount[r.code] ?? 0) > 0}
                          title={
                            (userCount[r.code] ?? 0) > 0
                              ? "이 역할을 가진 사용자가 있어 삭제할 수 없습니다"
                              : undefined
                          }
                        >
                          삭제
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}


/** Knowledge-base (RAG) management — opens the existing ProjectModal
 *  in admin mode so the operator can create shared knowledge bases
 *  and map them to roles. Users with a granted role then get the
 *  base auto-searched in chat without any per-session linking. */
function KnowledgePanel({ isAdmin }: { isAdmin: boolean }) {
  const { projects, refresh, remove } = useProjects();
  const [busyId, setBusyId] = useState<string | null>(null);
  // Modal popup state. `addOpen` = blank add form; `focusId` = open
  // the modal with that project pre-selected on the detail pane so
  // 편집 / 스냅샷 / 다시 인덱싱 are one click away.
  const [addOpen, setAddOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [snapshotFocusId, setSnapshotFocusId] = useState<string | null>(null);
  const modalOpen = addOpen || focusId !== null || snapshotFocusId !== null;

  useEffect(() => { refresh(); }, [refresh]);

  function corpusLabel(t: string): string {
    return (
      { code: "코드", document: "문서", api: "API", db: "DB" } as Record<string, string>
    )[t] || t;
  }

  function statusLabel(p: Project): string {
    switch (p.status) {
      case "ready": return "준비됨";
      case "indexing":
        return p.progress_total
          ? `인덱싱 ${Math.round((100 * p.progress_done) / p.progress_total)}%`
          : "인덱싱";
      case "pending": return "대기";
      case "failed": return "실패";
      default: return p.status;
    }
  }

  async function deleteProject(p: Project) {
    if (!window.confirm(`"${p.name}" 을(를) 삭제할까요?\n인덱스도 함께 사라집니다.`)) return;
    setBusyId(p.id);
    try {
      await remove(p.id);
    } catch (e) {
      window.alert(`삭제 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="admin-roles">
      <div className="admin-roles-head">
        <div>
          <h2>지식베이스 (RAG)</h2>
          <p>
            공유 지식베이스를 만들고 역할에 매핑하면, 권한이 있는 사용자는
            채팅에 연결하지 않아도 질문과 관련될 때 자동으로 검색해
            활용합니다.{isAdmin ? "" : " (생성·역할 매핑은 관리자만 가능)"}
          </p>
        </div>
        {isAdmin && (
          <button
            type="button"
            className="admin-btn admin-btn-primary"
            onClick={() => { setFocusId(null); setAddOpen(true); }}
          >
            RAG 추가
          </button>
        )}
      </div>

      <table className="admin-table">
        <thead>
          <tr>
            <th>이름</th>
            <th>코퍼스</th>
            <th>소스</th>
            <th>상태</th>
            <th>공유</th>
            <th>스냅샷</th>
            <th className="admin-actions-col">작업</th>
          </tr>
        </thead>
        <tbody>
          {projects.length === 0 ? (
            <tr>
              <td colSpan={7} className="admin-cell-muted" style={{ textAlign: "center", padding: "24px" }}>
                아직 등록된 지식베이스가 없습니다. 위 <b>RAG 추가</b> 버튼으로 시작하세요.
              </td>
            </tr>
          ) : projects.map((p) => (
            <tr key={p.id} className={busyId === p.id ? "busy" : ""}>
              <td>
                <div>{p.name}</div>
                {!p.owned && <span className="admin-cell-muted">(공유 — 읽기 전용)</span>}
              </td>
              <td>
                <span className="admin-role-base base-user">
                  {corpusLabel(p.corpus_type)}
                </span>
              </td>
              <td className="admin-cell-muted" style={{ fontFamily: "ui-monospace, monospace", fontSize: 11.5 }}>
                {p.source_type}
              </td>
              <td>
                <span className={`admin-status admin-status-${p.status === "ready" ? "approved" : p.status === "failed" ? "rejected" : "pending"}`}>
                  {statusLabel(p)}
                </span>
              </td>
              <td>
                {p.is_shared
                  ? (p.role_codes.length > 0 ? `${p.role_codes.length}개 역할` : "공유 (역할 없음)")
                  : <span className="admin-cell-muted">개인</span>}
              </td>
              <td>
                <button
                  type="button"
                  className="admin-btn admin-link-btn"
                  onClick={() => {
                    setAddOpen(false);
                    setFocusId(null);
                    setSnapshotFocusId(p.id);
                  }}
                  disabled={(p.snapshots?.length ?? 0) === 0}
                  title="스냅샷 이력 보기"
                >
                  {p.snapshots?.length ?? 0}개
                </button>
              </td>
              <td className="admin-actions-col">
                <div className="admin-actions">
                  <button
                    type="button"
                    className="admin-btn"
                    onClick={() => { setAddOpen(false); setFocusId(p.id); }}
                  >
                    관리
                  </button>
                  {(p.owned || isAdmin) && (
                    <button
                      type="button"
                      className="admin-btn admin-btn-danger"
                      onClick={() => deleteProject(p)}
                      disabled={busyId === p.id}
                    >
                      삭제
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ProjectModal
        open={modalOpen}
        onClose={() => {
          setAddOpen(false);
          setFocusId(null);
          setSnapshotFocusId(null);
          refresh();
        }}
        adminMode={isAdmin}
        initialAddOpen={addOpen}
        initialProjectId={focusId || snapshotFocusId}
        initialSnapshotsOpen={snapshotFocusId !== null}
      />
    </div>
  );
}



/**
 * 오류 모니터링 — 운영자가 SSH·로그 안 보고도 최근 실패한 작업을
 * 한 화면에서 확인할 수 있도록. 카테고리별 (전사 / RAG / 워크플로)
 * 가장 최근 50건씩 + 전체 새로고침 + 자동 폴링 30초.
 */
function ErrorsPanel() {
  type Data = Awaited<ReturnType<typeof admin.listErrors>>;
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  async function refresh() {
    try {
      const r = await admin.listErrors(50);
      setData(r);
      setErr(null);
      setLastRefresh(new Date());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (loading) return <div className="admin-empty">불러오는 중...</div>;
  if (err)
    return <div className="admin-empty admin-error">오류: {err}</div>;
  if (!data) return null;

  const total =
    data.transcripts.length +
    data.projects.length +
    data.workflows.length +
    (data.app_errors?.length ?? 0);

  return (
    <div className="admin-errors">
      <div className="admin-errors-head">
        <div>
          <h2>최근 실패한 작업</h2>
          <p>
            전사 / RAG / 워크플로의 가장 최근 실패 기록을 한 화면에서
            확인합니다. 30초마다 자동 갱신.
            {lastRefresh && (
              <span className="admin-errors-stamp">
                {" "}· 최근 갱신: {lastRefresh.toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>
        <button type="button" className="admin-btn" onClick={refresh}>
          새로고침
        </button>
      </div>

      {total === 0 ? (
        <div className="admin-empty">
          ✓ 최근 실패한 작업이 없습니다.
        </div>
      ) : (
        <>
          <ErrorSection
            title={`전사(회의록) 실패 — ${data.transcripts.length}건`}
            empty="전사 실패 없음"
            rows={data.transcripts.map((t) => ({
              key: t.id,
              who: t.user_email,
              what: t.source_filename,
              when: t.updated_at,
              error: t.error,
            }))}
          />
          <ErrorSection
            title={`RAG 지식베이스 실패 — ${data.projects.length}건`}
            empty="RAG 실패 없음"
            rows={data.projects.map((p) => ({
              key: p.id,
              who: p.owner_email,
              what: `${p.name}  ·  ${p.source_type}`,
              when: p.updated_at,
              error: p.error,
            }))}
          />
          <ErrorSection
            title={`워크플로 실패 — ${data.workflows.length}건`}
            empty="워크플로 실패 없음"
            rows={data.workflows.map((w) => ({
              key: w.id,
              who: w.user_email,
              what: w.name,
              when: w.last_run_at,
              error: w.last_error,
            }))}
          />
          <ErrorSection
            title={`백엔드 일반 오류 — ${(data.app_errors ?? []).length}건`}
            empty="기록된 백엔드 오류 없음"
            rows={(data.app_errors ?? []).map((r) => ({
              key: r.id,
              who:
                r.user_email ??
                (r.ip ? `(익명 · ${r.ip})` : "(익명)"),
              what:
                `[${r.level}] ${r.source}` +
                (r.method && r.path
                  ? `  ${r.method} ${r.path}`
                  : "") +
                (r.status_code ? `  → ${r.status_code}` : ""),
              when: r.created_at,
              error: r.traceback
                ? `${r.message}\n\n${r.traceback}`
                : r.message,
            }))}
          />
        </>
      )}
    </div>
  );
}

function ErrorSection({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{
    key: string;
    who: string;
    what: string;
    when: string | null;
    error: string;
  }>;
}) {
  return (
    <section className="admin-error-section">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <div className="admin-empty admin-empty-soft">{empty}</div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th style={{ width: "16%" }}>사용자</th>
              <th style={{ width: "24%" }}>대상</th>
              <th style={{ width: "14%" }}>시각</th>
              <th>오류 메시지</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="admin-error-who" title={r.who}>{r.who}</td>
                <td className="admin-error-what" title={r.what}>{r.what}</td>
                <td className="admin-error-when">
                  {r.when ? new Date(r.when).toLocaleString() : "-"}
                </td>
                <td>
                  <code className="admin-error-msg">{r.error || "(메시지 없음)"}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * 감사 로그 뷰어 — audit_log 테이블의 모든 행을 검색·필터해서 본다.
 * event / 사용자 이메일 부분 일치 / 최대 행수.
 */
function AuditPanel() {
  type Row = Awaited<ReturnType<typeof admin.listAudit>>[number];
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [event, setEvent] = useState("");
  const [userQ, setUserQ] = useState("");
  const [limit, setLimit] = useState(100);

  async function refresh() {
    setLoading(true);
    try {
      const r = await admin.listAudit({
        event: event || undefined,
        userQ: userQ || undefined,
        limit,
      });
      setRows(r);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  return (
    <div className="admin-errors">
      <div className="admin-errors-head">
        <div>
          <h2>감사 로그</h2>
          <p>로그인·회원가입·비밀번호 변경·계정 삭제 등 사용자 활동 이력입니다.</p>
        </div>
      </div>
      <div className="admin-audit-filters">
        <input
          type="text"
          placeholder="이벤트 (예: login_ok)"
          value={event}
          onChange={(e) => setEvent(e.target.value.trim())}
          onKeyDown={(e) => { if (e.key === "Enter") refresh(); }}
        />
        <input
          type="text"
          placeholder="이메일 검색"
          value={userQ}
          onChange={(e) => setUserQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") refresh(); }}
        />
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          <option value={50}>최근 50</option>
          <option value={100}>최근 100</option>
          <option value={200}>최근 200</option>
          <option value={500}>최근 500</option>
        </select>
        <button type="button" className="admin-btn" onClick={refresh}>검색</button>
      </div>

      {loading ? (
        <div className="admin-empty">불러오는 중...</div>
      ) : err ? (
        <div className="admin-empty admin-error">오류: {err}</div>
      ) : rows.length === 0 ? (
        <div className="admin-empty">조건에 맞는 기록이 없습니다.</div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th style={{ width: "16%" }}>시각</th>
              <th style={{ width: "12%" }}>이벤트</th>
              <th style={{ width: "20%" }}>사용자</th>
              <th style={{ width: "12%" }}>IP</th>
              <th>상세</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="admin-error-when">
                  {r.created_at ? new Date(r.created_at).toLocaleString() : "-"}
                </td>
                <td><code>{r.event}</code></td>
                <td className="admin-error-who" title={r.user_id ?? ""}>{r.user_email}</td>
                <td><code>{r.ip || "-"}</code></td>
                <td>{r.detail || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * 활성 세션 + 강제 로그아웃. JWT 가 stateless 라 "지금 떠 있는" 세션
 * 목록은 정확히 만들 수 없고, 마지막 로그인 시각이 토큰 컷오프 이후인
 * 사용자를 근사로 본다. 강제 로그아웃을 누르면 그 사용자의 모든 토큰
 * 이 즉시 만료된다.
 */
function ActiveSessionsPanel() {
  type Row = Awaited<ReturnType<typeof admin.listActiveSessions>>[number];
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const r = await admin.listActiveSessions();
      setRows(r);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refresh(); }, []);

  async function forceLogout(r: Row) {
    if (!window.confirm(`${r.email} 의 모든 활성 토큰을 즉시 무효화합니다.\n계속할까요?`)) return;
    setBusyId(r.user_id);
    try {
      await admin.forceLogoutUser(r.user_id);
      await refresh();
    } catch (e) {
      window.alert(`실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="admin-errors">
      <div className="admin-errors-head">
        <div>
          <h2>활성 세션</h2>
          <p>
            마지막 로그인 시각이 토큰 무효화 시점보다 이후인 사용자입니다.
            강제 로그아웃을 누르면 해당 사용자의 모든 JWT 가 즉시 만료됩니다.
          </p>
        </div>
        <button type="button" className="admin-btn" onClick={refresh}>새로고침</button>
      </div>
      {loading ? (
        <div className="admin-empty">불러오는 중...</div>
      ) : err ? (
        <div className="admin-empty admin-error">오류: {err}</div>
      ) : rows.length === 0 ? (
        <div className="admin-empty">현재 활성 세션이 없습니다.</div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th>이메일</th>
              <th>역할</th>
              <th>마지막 로그인</th>
              <th>마지막 무효화</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.user_id}>
                <td>{r.email}</td>
                <td><code>{r.role}</code></td>
                <td className="admin-error-when">{new Date(r.last_login_at).toLocaleString()}</td>
                <td className="admin-error-when">
                  {r.tokens_invalidated_at
                    ? new Date(r.tokens_invalidated_at).toLocaleString()
                    : "—"}
                </td>
                <td>
                  <button
                    type="button"
                    className="admin-btn admin-btn-danger"
                    onClick={() => forceLogout(r)}
                    disabled={busyId === r.user_id}
                  >
                    {busyId === r.user_id ? "처리 중…" : "강제 로그아웃"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * 운영 대시보드 — 시스템 자원 / 모델별 사용량 / 사용자 활동 / 백업.
 * 한 화면에 네 섹션으로 묶어, 관리자가 한 페이지에서 운영 현황을 본다.
 */
function OpsDashboardPanel() {
  return (
    <div className="admin-errors">
      <div className="admin-errors-head">
        <div>
          <h2>운영 대시보드</h2>
          <p>시스템 자원·모델 사용·사용자 활동·백업을 한 화면에서 확인합니다.</p>
        </div>
      </div>
      <SystemResourcesPanel />
      <ModelUsagePanel />
      <UserActivityPanel />
      <BackupsPanel />
    </div>
  );
}

function SystemResourcesPanel() {
  type Snap = Awaited<ReturnType<typeof admin.systemResources>>;
  const [snap, setSnap] = useState<Snap | null>(null);
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const s = await admin.systemResources();
        if (alive) setSnap(s);
      } catch { /* ignore */ }
    }
    tick();
    const id = window.setInterval(tick, 5000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  if (!snap) return <SectionCard title="시스템 자원">불러오는 중…</SectionCard>;

  return (
    <SectionCard title="시스템 자원 (5초마다 갱신)">
      <div className="ops-grid">
        <Stat label="CPU 사용률" value={`${snap.cpu.percent.toFixed(1)}%`}
              note={`${snap.cpu.cores} cores${snap.cpu.load_avg.length ? ` · load ${snap.cpu.load_avg.map(n=>n.toFixed(2)).join("/")}` : ""}`}
              pct={snap.cpu.percent} />
        <Stat label="메모리" value={`${snap.memory.pct.toFixed(1)}%`}
              note={`${fmtBytes(snap.memory.used)} / ${fmtBytes(snap.memory.total)}`}
              pct={snap.memory.pct} />
        {snap.disks.map((d) => (
          <Stat
            key={d.path}
            label={`디스크 ${d.path}`}
            value={d.error ? "—" : `${d.pct?.toFixed(1)}%`}
            note={d.error ? d.error : `${fmtBytes(d.used ?? 0)} / ${fmtBytes(d.total ?? 0)}`}
            pct={d.pct ?? 0}
          />
        ))}
      </div>
      {snap.gpu && snap.gpu.length > 0 && (
        <table className="admin-table admin-error-table" style={{ marginTop: 12 }}>
          <thead>
            <tr><th>GPU</th><th>모델</th><th>사용률</th><th>메모리</th><th>온도</th></tr>
          </thead>
          <tbody>
            {snap.gpu.map((g) => (
              <tr key={g.index}>
                <td>#{g.index}</td>
                <td>{g.name}</td>
                <td>{g.utilization_pct}%</td>
                <td>{g.memory_used_mb} / {g.memory_total_mb} MB</td>
                <td>{g.temperature_c}°C</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

function ModelUsagePanel() {
  type Row = Awaited<ReturnType<typeof admin.modelUsage>>[number];
  const [rows, setRows] = useState<Row[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  async function refresh() {
    setLoading(true);
    try { setRows(await admin.modelUsage(days)); }
    catch { /* ignore */ }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [days]);

  const totalCost = rows.reduce((a, r) => a + r.estimated_cost_krw, 0);
  const totalTokens = rows.reduce((a, r) => a + r.tokens_out, 0);

  return (
    <SectionCard
      title={`모델별 사용 통계 (최근 ${days}일)`}
      right={
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>최근 7일</option>
          <option value={30}>최근 30일</option>
          <option value={90}>최근 90일</option>
        </select>
      }
    >
      {loading ? (
        <div className="admin-empty">불러오는 중…</div>
      ) : rows.length === 0 ? (
        <div className="admin-empty">기록이 없습니다.</div>
      ) : (
        <>
          <table className="admin-table admin-error-table">
            <thead>
              <tr>
                <th>모델</th><th>호출</th><th>출력 토큰</th>
                <th>평균 지연</th><th>출력 단가 (₩/1k)</th><th>추정 비용 (₩)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.provider}>
                  <td><code>{r.provider}</code></td>
                  <td>{r.calls.toLocaleString()}</td>
                  <td>{r.tokens_out.toLocaleString()}</td>
                  <td>{r.avg_latency_ms.toLocaleString()} ms</td>
                  <td>{r.output_rate_krw_per_1k.toLocaleString()}</td>
                  <td>{r.estimated_cost_krw.toLocaleString()}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 600, borderTop: "2px solid var(--border)" }}>
                <td>합계</td>
                <td>{rows.reduce((a, r) => a + r.calls, 0).toLocaleString()}</td>
                <td>{totalTokens.toLocaleString()}</td>
                <td></td>
                <td></td>
                <td>{totalCost.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
          <div className="pm-help" style={{ marginTop: 6 }}>
            비용은 .env <code>MODEL_COST_RATES</code> 의 단가표를 기준으로 한 추정치입니다.
          </div>
        </>
      )}
    </SectionCard>
  );
}

function UserActivityPanel() {
  type Row = Awaited<ReturnType<typeof admin.userActivity>>[number];
  const [rows, setRows] = useState<Row[]>([]);
  const [days, setDays] = useState(30);
  async function refresh() {
    try { setRows(await admin.userActivity(days, 100)); } catch { /* ignore */ }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [days]);

  return (
    <SectionCard
      title={`사용자별 활동 (최근 ${days}일)`}
      right={
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>최근 7일</option>
          <option value={30}>최근 30일</option>
          <option value={90}>최근 90일</option>
        </select>
      }
    >
      {rows.length === 0 ? (
        <div className="admin-empty">기록이 없습니다.</div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th>이메일</th><th>역할</th><th>세션</th><th>메시지</th>
              <th>출력 토큰</th><th>로그인</th><th>마지막 활동</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.user_id}>
                <td>{r.email}</td>
                <td><code>{r.role}</code></td>
                <td>{r.session_count}</td>
                <td>{r.msg_count.toLocaleString()}</td>
                <td>{r.tokens_out.toLocaleString()}</td>
                <td>{r.logins}</td>
                <td className="admin-error-when">
                  {r.last_message_at
                    ? new Date(r.last_message_at).toLocaleString()
                    : r.last_login_at
                    ? new Date(r.last_login_at).toLocaleString()
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

function BackupsPanel() {
  type Item = { name: string; size_bytes: number; mtime: string };
  const [items, setItems] = useState<Item[]>([]);
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await admin.listBackups();
      setItems(r.files);
      setDir(r.backup_dir);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => { refresh(); }, []);

  async function trigger() {
    setBusy(true);
    setErr(null);
    try {
      await admin.createBackup();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    if (!window.confirm(`${name} 백업을 삭제할까요?`)) return;
    try {
      await admin.deleteBackup(name);
      await refresh();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <SectionCard
      title="DB 백업"
      right={
        <button type="button" className="admin-btn" onClick={trigger} disabled={busy}>
          {busy ? "백업 중…" : "지금 백업"}
        </button>
      }
    >
      <div className="pm-help" style={{ marginBottom: 8 }}>
        디렉터리: <code>{dir || "(미설정)"}</code> · WAL 체크포인트 후 복사합니다.
      </div>
      {err && <div className="admin-empty admin-error">{err}</div>}
      {items.length === 0 ? (
        <div className="admin-empty">백업 파일이 없습니다.</div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr><th>이름</th><th>크기</th><th>시각</th><th></th></tr>
          </thead>
          <tbody>
            {items.map((b) => (
              <tr key={b.name}>
                <td><code>{b.name}</code></td>
                <td>{fmtBytes(b.size_bytes)}</td>
                <td className="admin-error-when">{new Date(b.mtime).toLocaleString()}</td>
                <td>
                  <a
                    href={`/api/admin/backups/${encodeURIComponent(b.name)}`}
                    onClick={(e) => {
                      // localStorage 토큰을 헤더로 못 박으니까 fetch 후
                      // blob 다운로드.
                      e.preventDefault();
                      void downloadAuthed(`/api/admin/backups/${encodeURIComponent(b.name)}`, b.name);
                    }}
                    className="admin-btn"
                    style={{ marginRight: 6 }}
                  >다운로드</a>
                  <button
                    type="button"
                    className="admin-btn admin-btn-danger"
                    onClick={() => remove(b.name)}
                  >삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

async function downloadAuthed(url: string, filename: string) {
  const token = localStorage.getItem("chat:token") || "";
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    window.alert(`다운로드 실패: ${res.status}`);
    return;
  }
  const blob = await res.blob();
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(u);
}

function SectionCard({
  title, right, children,
}: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="admin-error-section" style={{ marginTop: 18 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3>{title}</h3>
        {right}
      </header>
      <div>{children}</div>
    </section>
  );
}

function Stat({ label, value, note, pct }: { label: string; value: string; note: string; pct: number }) {
  const tone = pct > 85 ? "danger" : pct > 70 ? "warn" : "ok";
  return (
    <div className={`ops-stat ops-${tone}`}>
      <div className="ops-stat-label">{label}</div>
      <div className="ops-stat-value">{value}</div>
      <div className="ops-stat-bar">
        <div className="ops-stat-bar-fill" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="ops-stat-note">{note}</div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (!n) return "0";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}


// ── 답변 품질 분석 (#37) ─────────────────────────────────────
// 👎 받은 어시스턴트 답변을 한 곳에 모아 운영자가 어떤 부분이
// 부족했는지 점검.  세션 본문으로 점프 가능.
function QualityPanel() {
  type Row = Awaited<ReturnType<typeof admin.listDisliked>>[number];
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const r = await admin.listDisliked(100);
        setRows(r);
        setErr(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="admin-empty">불러오는 중...</div>;
  if (err) return <div className="admin-empty admin-error">{err}</div>;

  return (
    <div className="admin-errors">
      <div className="admin-errors-head">
        <div>
          <h2>👎 답변 품질 — 싫어요 받은 답변</h2>
          <p>
            사용자가 만족하지 못한 답변을 한 화면에서 점검할 수 있어요.
            메모가 있으면 어떤 점이 아쉬웠는지 함께 표시됩니다.
          </p>
        </div>
        <span className="admin-errors-stamp">{rows.length}건</span>
      </div>
      {rows.length === 0 ? (
        <div className="admin-empty">✓ 최근 싫어요 표시된 답변이 없습니다.</div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th>사용자</th>
              <th>세션</th>
              <th>답변</th>
              <th>메모</th>
              <th>시각</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.message_id}>
                <td>{r.user_email}</td>
                <td>
                  <a
                    href={`?session=${r.session_id}&message=${r.message_id}`}
                    title="이 세션으로 이동"
                  >
                    {r.session_title}
                  </a>
                </td>
                <td>
                  <div className="admin-quality-snippet">{r.content}</div>
                  {r.provider && (
                    <div className="admin-quality-meta">{r.provider}</div>
                  )}
                </td>
                <td>
                  {r.feedback_note ? (
                    <div className="admin-quality-note">{r.feedback_note}</div>
                  ) : (
                    <span className="admin-cell-muted">—</span>
                  )}
                </td>
                <td>
                  {r.created_at
                    ? new Date(r.created_at).toLocaleString()
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}


// ── 시스템 헬스 인디케이터 (#39) ───────────────────────────
// 관리자 헤더에 작은 점등 — Ollama / Qdrant / DB / 최근 에러 카운트.
// 30 초마다 자동 갱신.  데이터가 안 와도 페이지 자체는 정상 동작.
export function HealthIndicator() {
  type Data = Awaited<ReturnType<typeof admin.health>>;
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await admin.health();
        if (!cancelled) setData(r);
      } catch {
        if (!cancelled) setData(null);
      }
    }
    void tick();
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  if (!data) return null;
  const overall =
    data.ollama.ok && data.qdrant.ok && data.db.ok && data.errors_24h < 5;
  const status = overall ? "ok" : data.db.ok ? "warn" : "err";
  return (
    <div className={`admin-health admin-health-${status}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="시스템 헬스 — 클릭해 자세히"
      >
        <span className="admin-health-dot" /> 헬스
      </button>
      {open && (
        <div className="admin-health-pop">
          <Row k="Ollama" v={data.ollama} />
          <Row k="Qdrant" v={data.qdrant} />
          <Row k="DB" v={data.db} />
          <div className="admin-health-row">
            <span>24시간 오류</span>
            <b>{data.errors_24h.toLocaleString()}</b>
          </div>
          <div className="admin-health-checked">
            점검: {new Date(data.checked_at).toLocaleTimeString()}
          </div>
        </div>
      )}
    </div>
  );
}
function Row({ k, v }: { k: string; v: { ok: boolean; latency_ms?: number; error?: string } }) {
  return (
    <div className="admin-health-row">
      <span>
        {v.ok ? "✓" : "✕"} {k}
      </span>
      <b>{v.ok ? `${v.latency_ms ?? "?"}ms` : v.error || "fail"}</b>
    </div>
  );
}


// ── 사용자별 사용량 (#41) ───────────────────────────────────
function UsagePanel() {
  type Data = Awaited<ReturnType<typeof admin.listUsage>>;
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function refresh(d: number) {
    setLoading(true);
    try {
      const r = await admin.listUsage(d);
      setData(r);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh(days);
  }, [days]);

  if (loading) return <div className="admin-empty">불러오는 중...</div>;
  if (err) return <div className="admin-empty admin-error">{err}</div>;
  if (!data) return null;
  return (
    <div className="admin-errors">
      <div className="admin-errors-head">
        <div>
          <h2>📈 사용자별 사용량</h2>
          <p>
            최근 {data.days} 일 — 메시지 수 / 출력 토큰 / 평균 응답 시간 /
            마지막 활동.
          </p>
        </div>
        <div className="admin-usage-range">
          {[7, 30, 90, 365].map((d) => (
            <button
              key={d}
              type="button"
              className={`admin-tab${days === d ? " active" : ""}`}
              onClick={() => setDays(d)}
            >
              {d}일
            </button>
          ))}
        </div>
      </div>
      {data.items.length === 0 ? (
        <div className="admin-empty">최근 사용 기록이 없어요.</div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th>사용자</th>
              <th>메시지</th>
              <th>출력 토큰</th>
              <th>평균 응답</th>
              <th>마지막 활동</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.user_id}>
                <td>
                  <div className="admin-user-name">{r.name || r.email}</div>
                  <div className="admin-user-email">{r.email}</div>
                </td>
                <td>{r.message_count.toLocaleString()}</td>
                <td>{r.tokens_out_sum.toLocaleString()}</td>
                <td>
                  {r.avg_latency_ms != null
                    ? `${(r.avg_latency_ms / 1000).toFixed(1)}s`
                    : "—"}
                </td>
                <td>
                  {r.last_activity
                    ? new Date(r.last_activity).toLocaleString()
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
