import { useCallback, useEffect, useMemo, useState } from "react";
import {
  admin,
  api,
  type AdminUser,
  type AppSettings,
  type BuiltinRole,
  type Project,
  type Prompt,
  type Role,
  type UserRole,
  type UserStatus,
  type Workflow,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { IconCheck, IconX } from "../components/Icon";
import { ProjectModal } from "../components/ProjectModal";
import { useProjects } from "../state/ProjectsContext";

interface Props {
  onBack: () => void;
}

type View = "users" | "roles" | "knowledge" | "prompts" | "workflows";

type Tab = "pending" | "approved" | "suspended" | "rejected" | "all";

const VIEW_LABELS: Record<View, string> = {
  users: "사용자",
  roles: "역할 코드",
  knowledge: "지식베이스",
  prompts: "프롬프트",
  workflows: "워크플로",
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
        <button className="admin-back" onClick={onBack}>
          ← 뒤로
        </button>
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
      {view === "prompts" && (
        <PromptsPanel isAdmin={isAdmin} roles={roles} />
      )}
      {view === "workflows" && <WorkflowsPanel isAdmin={isAdmin} />}

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
                    <span>{roleLabel(u.role)}</span>
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
      </>
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


function PromptsPanel({ isAdmin, roles }: { isAdmin: boolean; roles: Role[] }) {
  const [items, setItems] = useState<Prompt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    code: "",
    name: "",
    description: "",
    body: "",
    category: "",
    tags: "",
    is_shared: true,
    role_codes: new Set<string>(),
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, {
    name: string; description: string; body: string;
    category: string; tags: string;
    is_shared: boolean; role_codes: Set<string>;
  }>>({});

  const refresh = useCallback(async () => {
    try {
      const list = await api.listPrompts();
      setItems(list);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+\s/, "") : "프롬프트 목록 실패");
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function create() {
    if (!draft.code.trim() || !draft.name.trim() || !draft.body.trim()) {
      setError("코드·이름·본문은 필수입니다.");
      return;
    }
    setBusyId("__new__");
    setError(null);
    try {
      await api.createPrompt({
        code: draft.code.trim().toLowerCase(),
        name: draft.name.trim(),
        description: draft.description.trim(),
        body: draft.body,
        category: draft.category.trim(),
        tags: draft.tags.trim(),
        is_shared: draft.is_shared,
        role_codes: Array.from(draft.role_codes),
      });
      setDraft({
        code: "", name: "", description: "", body: "",
        category: "", tags: "", is_shared: true,
        role_codes: new Set(),
      });
      setAdding(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+\s/, "") : "추가 실패");
    } finally {
      setBusyId(null);
    }
  }

  async function save(p: Prompt) {
    const buf = editing[p.id];
    if (!buf) return;
    setBusyId(p.id);
    setError(null);
    try {
      await api.updatePrompt(p.id, {
        name: buf.name.trim(),
        description: buf.description.trim(),
        body: buf.body,
        category: buf.category.trim(),
        tags: buf.tags.trim(),
        is_shared: buf.is_shared,
        role_codes: Array.from(buf.role_codes),
      });
      setEditing((prev) => {
        const next = { ...prev }; delete next[p.id]; return next;
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+\s/, "") : "저장 실패");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(p: Prompt) {
    if (!window.confirm(`'${p.name}' 프롬프트를 삭제하시겠어요?`)) return;
    setBusyId(p.id);
    try {
      await api.deletePrompt(p.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+\s/, "") : "삭제 실패");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="admin-roles">
      <div className="admin-roles-head">
        <div>
          <h2>프롬프트 라이브러리</h2>
          <p>
            자주 쓰는 질문/지시문을 템플릿으로 저장합니다. <code>{"{변수명}"}</code> 자리는
            사용 시점에 채워집니다. 공유 프롬프트는 매핑된 역할의 사용자가
            채팅 입력창과 워크플로에서 바로 끼울 수 있습니다.
          </p>
        </div>
        {!adding && (
          <button
            type="button"
            className="admin-btn admin-btn-primary"
            onClick={() => setAdding(true)}
          >
            새 프롬프트
          </button>
        )}
      </div>
      {error && <div className="admin-error">{error}</div>}

      {adding && (
        <div className="admin-role-add">
          <div className="admin-role-add-grid">
            <label><span>코드</span><input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toLowerCase() })} placeholder="예: weekly-report" maxLength={60} /></label>
            <label><span>이름</span><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="예: 주간 보고서 초안" maxLength={120} /></label>
            <label><span>카테고리</span><input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} placeholder="선택" maxLength={40} /></label>
            <label className="admin-role-add-desc"><span>본문</span>
              <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={8} placeholder={"예) 이번 주 회의록을 토대로 {부서}의 주간 보고서를 작성해줘. 항목: 진행 현황 / 이슈 / 다음 주 계획."} />
            </label>
            <label className="admin-role-add-desc"><span>태그 (쉼표)</span><input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="예: 보고서, 주간" maxLength={200} /></label>
            <label className="admin-role-add-desc"><span>설명</span><input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="이 프롬프트가 하는 일을 한 줄로" maxLength={500} /></label>
          </div>
          {isAdmin && (
            <div className="pm-share-field" style={{ marginTop: 12 }}>
              <label className="pm-share-toggle">
                <input type="checkbox" checked={draft.is_shared} onChange={(e) => setDraft({ ...draft, is_shared: e.target.checked })} />
                <span><b>공유 프롬프트</b><span className="pm-help">아래 역할 사용자가 채팅·워크플로에서 사용</span></span>
              </label>
              {draft.is_shared && (
                <div className="pm-share-roles">
                  <div className="pm-share-role-grid">
                    {roles.map((r) => (
                      <label key={r.code} className="pm-share-role-chip">
                        <input type="checkbox" checked={draft.role_codes.has(r.code)} onChange={(e) => setDraft((d) => {
                          const next = new Set(d.role_codes);
                          if (e.target.checked) next.add(r.code); else next.delete(r.code);
                          return { ...d, role_codes: next };
                        })} />
                        <span>{r.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="admin-role-add-actions">
            <button type="button" className="admin-btn admin-btn-primary" disabled={busyId === "__new__"} onClick={create}>
              {busyId === "__new__" ? "추가 중…" : "추가"}
            </button>
            <button type="button" className="admin-btn" disabled={busyId === "__new__"} onClick={() => setAdding(false)}>취소</button>
          </div>
        </div>
      )}

      <table className="admin-table">
        <thead>
          <tr><th>코드</th><th>이름</th><th>카테고리</th><th>공유</th><th className="admin-actions-col">작업</th></tr>
        </thead>
        <tbody>
          {items.map((p) => {
            const buf = editing[p.id]; const inEdit = !!buf;
            return (
              <tr key={p.id} className={busyId === p.id ? "busy" : ""}>
                <td><code className="admin-role-code">{p.code}</code></td>
                <td>{inEdit ? <input value={buf.name} onChange={(e) => setEditing((prev) => ({ ...prev, [p.id]: { ...buf, name: e.target.value } }))} /> : p.name}</td>
                <td>{inEdit ? <input value={buf.category} onChange={(e) => setEditing((prev) => ({ ...prev, [p.id]: { ...buf, category: e.target.value } }))} /> : (p.category || <span className="admin-cell-muted">—</span>)}</td>
                <td>{p.is_shared ? `공유 (${p.role_codes.length})` : <span className="admin-cell-muted">개인</span>}</td>
                <td className="admin-actions-col">
                  {inEdit ? (
                    <div className="admin-actions">
                      <button className="admin-btn admin-btn-primary" onClick={() => save(p)} disabled={busyId === p.id}>저장</button>
                      <button className="admin-btn" onClick={() => setEditing((prev) => { const n = { ...prev }; delete n[p.id]; return n; })} disabled={busyId === p.id}>취소</button>
                    </div>
                  ) : (
                    <div className="admin-actions">
                      {(p.owned || isAdmin) && (
                        <button className="admin-btn" onClick={() => setEditing((prev) => ({ ...prev, [p.id]: {
                          name: p.name, description: p.description ?? "", body: p.body,
                          category: p.category ?? "", tags: p.tags ?? "",
                          is_shared: p.is_shared, role_codes: new Set(p.role_codes),
                        }}))}>편집</button>
                      )}
                      {(p.owned || isAdmin) && (
                        <button className="admin-btn admin-btn-danger" onClick={() => remove(p)}>삭제</button>
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


function WorkflowsPanel({ isAdmin: _isAdmin }: { isAdmin: boolean }) {
  const [items, setItems] = useState<Workflow[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    name: "", description: "",
    prompt_id: "", prompt_vars: {} as Record<string, string>,
    project_id: "", model: "",
    schedule_interval_minutes: 0,
    enabled: true,
  });

  const refresh = useCallback(async () => {
    try {
      const [w, p, proj] = await Promise.all([
        api.listWorkflows(),
        api.listPrompts(),
        api.listProjects().catch(() => [] as Project[]),
      ]);
      setItems(w); setPrompts(p); setProjects(proj);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+\s/, "") : "워크플로 목록 실패");
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Extract {var} placeholders from the picked prompt body.
  const promptBody = prompts.find((p) => p.id === draft.prompt_id)?.body ?? "";
  const vars = useMemo(() => {
    const out: string[] = []; const re = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g; let m: RegExpExecArray | null;
    while ((m = re.exec(promptBody)) !== null) { if (!out.includes(m[1])) out.push(m[1]); }
    return out;
  }, [promptBody]);

  async function create() {
    if (!draft.name.trim() || !draft.prompt_id) {
      setError("이름과 프롬프트는 필수입니다."); return;
    }
    setBusyId("__new__"); setError(null);
    try {
      await api.createWorkflow({
        name: draft.name.trim(),
        description: draft.description.trim(),
        prompt_id: draft.prompt_id,
        prompt_vars: Object.keys(draft.prompt_vars).length ? draft.prompt_vars : null,
        project_id: draft.project_id || null,
        model: draft.model.trim() || null,
        schedule_interval_minutes: draft.schedule_interval_minutes,
        enabled: draft.enabled,
      });
      setDraft({ name: "", description: "", prompt_id: "", prompt_vars: {}, project_id: "", model: "", schedule_interval_minutes: 0, enabled: true });
      setAdding(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+\s/, "") : "추가 실패");
    } finally {
      setBusyId(null);
    }
  }

  async function runNow(w: Workflow) {
    setBusyId(w.id);
    try {
      const updated = await api.runWorkflow(w.id);
      setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+\s/, "") : "실행 실패");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleEnabled(w: Workflow) {
    try {
      await api.updateWorkflow(w.id, { enabled: !w.enabled });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+\s/, "") : "변경 실패");
    }
  }

  async function remove(w: Workflow) {
    if (!window.confirm(`'${w.name}' 워크플로를 삭제하시겠어요?`)) return;
    setBusyId(w.id);
    try { await api.deleteWorkflow(w.id); await refresh(); }
    finally { setBusyId(null); }
  }

  const SCHEDULES: { label: string; mins: number }[] = [
    { label: "수동만", mins: 0 },
    { label: "1시간", mins: 60 },
    { label: "6시간", mins: 60 * 6 },
    { label: "1일", mins: 60 * 24 },
    { label: "1주", mins: 60 * 24 * 7 },
  ];

  return (
    <div className="admin-roles">
      <div className="admin-roles-head">
        <div>
          <h2>자동화 워크플로</h2>
          <p>
            프롬프트 + 변수 + (선택) 지식베이스를 정해진 시각에 자동
            실행합니다. 결과는 새 채팅 세션으로 만들어져 사이드바에 나타납니다.
            예약 실행은 정시·정분 또는 새벽에 정렬됩니다.
          </p>
        </div>
        {!adding && (
          <button type="button" className="admin-btn admin-btn-primary" onClick={() => setAdding(true)}>새 워크플로</button>
        )}
      </div>
      {error && <div className="admin-error">{error}</div>}

      {adding && (
        <div className="admin-role-add">
          <div className="admin-role-add-grid">
            <label><span>이름</span><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="예: 매일 영업 일일 요약" /></label>
            <label><span>모델 override</span><input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="비우면 기본 모델" /></label>
            <label className="admin-role-add-desc"><span>프롬프트</span>
              <select value={draft.prompt_id} onChange={(e) => setDraft({ ...draft, prompt_id: e.target.value, prompt_vars: {} })}>
                <option value="">— 선택 —</option>
                {prompts.map((p) => <option key={p.id} value={p.id}>{p.name}{p.code ? ` (${p.code})` : ""}</option>)}
              </select>
            </label>
            <label className="admin-role-add-desc"><span>연결 지식베이스 (선택)</span>
              <select value={draft.project_id} onChange={(e) => setDraft({ ...draft, project_id: e.target.value })}>
                <option value="">— 사용 안 함 —</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            {vars.length > 0 && (
              <div className="admin-role-add-desc">
                <span>변수</span>
                <div className="pm-share-role-grid" style={{ marginTop: 4 }}>
                  {vars.map((v) => (
                    <label key={v} style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200, textTransform: "none" }}>
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}><code>{`{${v}}`}</code></span>
                      <input value={draft.prompt_vars[v] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, prompt_vars: { ...d.prompt_vars, [v]: e.target.value } }))} />
                    </label>
                  ))}
                </div>
              </div>
            )}
            <label className="admin-role-add-desc"><span>예약</span>
              <div className="pm-share-role-grid">
                {SCHEDULES.map((s) => (
                  <label key={s.mins} className="pm-share-role-chip">
                    <input type="radio" name="wf-sched" checked={draft.schedule_interval_minutes === s.mins} onChange={() => setDraft({ ...draft, schedule_interval_minutes: s.mins })} />
                    <span>{s.label}</span>
                  </label>
                ))}
              </div>
            </label>
          </div>
          <div className="admin-role-add-actions">
            <button type="button" className="admin-btn admin-btn-primary" disabled={busyId === "__new__"} onClick={create}>{busyId === "__new__" ? "추가 중…" : "추가"}</button>
            <button type="button" className="admin-btn" disabled={busyId === "__new__"} onClick={() => setAdding(false)}>취소</button>
          </div>
        </div>
      )}

      <table className="admin-table">
        <thead>
          <tr><th>이름</th><th>프롬프트</th><th>지식베이스</th><th>예약</th><th>마지막</th><th className="admin-actions-col">작업</th></tr>
        </thead>
        <tbody>
          {items.map((w) => (
            <tr key={w.id} className={busyId === w.id ? "busy" : ""}>
              <td>
                <div>{w.name}</div>
                {!w.enabled && <span className="admin-cell-muted">(비활성)</span>}
              </td>
              <td>{w.prompt_name ?? <span className="admin-cell-muted">—</span>}</td>
              <td>{w.project_name ?? <span className="admin-cell-muted">—</span>}</td>
              <td>{w.schedule_interval_minutes > 0 ? `${w.schedule_interval_minutes}분` : "수동"}</td>
              <td>
                {w.last_run_status === "running" ? "실행 중…"
                  : w.last_run_status === "ok" ? `성공 · ${w.last_run_at ? new Date(w.last_run_at).toLocaleString() : ""}`
                  : w.last_run_status === "failed" ? <span title={w.last_error ?? ""}>실패</span>
                  : "—"}
              </td>
              <td className="admin-actions-col">
                <div className="admin-actions">
                  <button className="admin-btn admin-btn-primary" onClick={() => runNow(w)} disabled={busyId === w.id || w.last_run_status === "running"}>지금 실행</button>
                  <button className="admin-btn" onClick={() => toggleEnabled(w)}>{w.enabled ? "비활성" : "활성"}</button>
                  <button className="admin-btn admin-btn-danger" onClick={() => remove(w)}>삭제</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
