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
import { errorToast, infoToast } from "../lib/toast";
import { useIsMobile } from "../lib/useIsMobile";
import { IconCheck, IconPlus, IconX } from "../components/Icon";
import { ProjectModal } from "../components/ProjectModal";
import { RolePickerModal } from "../components/RolePickerModal";
import { useProjects } from "../state/ProjectsContext";
// 별 파일로 떨어진 admin 패널 — 메인 파일 3K줄 다이어트 (#125).
import { ActiveSessionsPanel } from "./panels/ActiveSessionsPanel";
import { AuditPanel } from "./panels/AuditPanel";
import { ErrorsPanel } from "./panels/ErrorsPanel";
import { HealthIndicator } from "./panels/HealthIndicator";
import { IntegrityPanel } from "./panels/IntegrityPanel";
import { KnowledgePanel } from "./panels/KnowledgePanel";
import { MonitorPanel } from "./panels/MonitorPanel";
import { OpsDashboardPanel } from "./panels/OpsDashboardPanel";
import { QualityPanel } from "./panels/QualityPanel";
import { RagQualityPanel } from "./panels/RagQualityPanel";
import { RolesPanel } from "./panels/RolesPanel";
import { UsagePanel } from "./panels/UsagePanel";

interface Props {
  onBack: () => void;
}

type View = "users" | "roles" | "knowledge" | "errors" | "audit" | "sessions" | "ops" | "quality" | "usage" | "rag" | "integrity" | "monitor";

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
  rag: "검색 품질",
  integrity: "데이터 정합성",
  monitor: "관측/모니터링",
};

// 12 개로 늘어난 탭을 4 개 카테고리로 묶어 헤더 가로 폭이 폭주하지
// 않게.  카테고리 안에서는 dropdown 으로 진입.
const VIEW_GROUPS: { label: string; views: View[] }[] = [
  { label: "사용자", views: ["users", "roles", "sessions"] },
  { label: "지식 / 답변", views: ["knowledge", "quality", "rag"] },
  { label: "관측", views: ["monitor", "audit", "ops", "usage"] },
  { label: "운영", views: ["errors", "integrity"] },
];

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

export function AdminPage({ onBack }: Props) {
  const isMobile = useIsMobile();
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
          {/* 모바일에선 그룹 dropdown 이 부모 가로-스크롤 컨테이너에 잘려
              안 보이는 문제가 있어, viewport 가 720 이하면 12개 sub-tab
              을 그냥 평탄하게 펼쳐 노출 (가로 스크롤로 접근). */}
          {isMobile
            ? VIEW_GROUPS.flatMap((g) => g.views).map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`admin-view-tab${view === v ? " active" : ""}`}
                  onClick={() => setView(v)}
                >
                  {VIEW_LABELS[v]}
                </button>
              ))
            : VIEW_GROUPS.map((g) => {
            const activeInGroup = g.views.includes(view);
            return (
              <div
                key={g.label}
                className={`admin-view-group${activeInGroup ? " active" : ""}`}
                style={{ position: "relative", display: "inline-block" }}
              >
                <details>
                  <summary
                    className={`admin-view-tab${activeInGroup ? " active" : ""}`}
                    style={{ cursor: "pointer", userSelect: "none" }}
                  >
                    {g.label}
                    {activeInGroup && (
                      <span style={{ marginLeft: 6, opacity: 0.7 }}>
                        — {VIEW_LABELS[view]}
                      </span>
                    )}
                  </summary>
                  <div
                    className="admin-view-group-menu"
                    style={{
                      position: "absolute",
                      background: "var(--bg-panel, #fff)",
                      border: "1px solid var(--border, #ddd)",
                      borderRadius: 6,
                      padding: 4,
                      boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                      zIndex: 10,
                      minWidth: 180,
                      marginTop: 2,
                    }}
                  >
                    {g.views.map((v) => (
                      <button
                        key={v}
                        type="button"
                        className={`admin-view-tab${view === v ? " active" : ""}`}
                        onClick={(e) => {
                          setView(v);
                          // close <details>
                          (e.currentTarget.closest("details") as HTMLDetailsElement | null)
                            ?.removeAttribute("open");
                        }}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          padding: "6px 10px",
                          border: "none",
                          background: "transparent",
                          cursor: "pointer",
                        }}
                      >
                        {VIEW_LABELS[v]}
                      </button>
                    ))}
                  </div>
                </details>
              </div>
            );
          })}
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
      {view === "rag" && (
        <RagQualityPanel
          appSettings={appSettings}
          setAppSettings={setAppSettings}
          isAdmin={isAdmin}
        />
      )}
      {view === "integrity" && <IntegrityPanel />}
      {view === "monitor" && <MonitorPanel />}

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








