import { useEffect, useMemo, useState, type ReactNode } from "react";
import { admin, api } from "../api/client";
import type {
  CorpusType,
  DbDriverInfo,
  DbTestResult,
  Project,
  Role,
  SourceType,
  SqlPreviewResult,
} from "../api/client";
import { useProjects } from "../state/ProjectsContext";
import {
  IconAlertTriangle,
  IconCheck,
  IconCheckCircle,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconCode,
  IconDatabase,
  IconDownload,
  IconFileText,
  IconFolder,
  IconGitBranch,
  IconGlobe,
  IconBookOpen,
  IconHistory,
  IconPlug,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from "./Icon";

const CORPUS_META: Record<
  CorpusType,
  {
    label: string;
    icon: ReactNode;
    hint: string;
    /** Connection methods allowed for this corpus type. Order in the
     *  UI matches the order here — the first entry becomes the
     *  default selection when the corpus tab changes. */
    sources: SourceType[];
  }
> = {
  code: {
    label: "코드",
    icon: <IconCode />,
    hint: "소스 트리(.py / .ts / .java / …). 함수 단위 검색에 강함.",
    sources: ["git", "folder"],
  },
  document: {
    label: "문서",
    icon: <IconFileText />,
    hint: "SFTP 서버에서 PDF·DOCX·MD를 받거나 백엔드 서버의 폴더 사용. 단락 단위 검색.",
    sources: ["sftp", "folder"],
  },
  api: {
    label: "API",
    icon: <IconPlug />,
    hint: "OpenAPI/Swagger 스펙이 응답되는 HTTPS 엔드포인트를 직접 fetch.",
    sources: ["url"],
  },
  db: {
    label: "DB",
    icon: <IconDatabase />,
    hint:
      "DB에 직접 접속해 스키마를 리플렉션. CREATE TABLE/VIEW/PROC 단위 분할.",
    sources: ["connection"],
  },
};

const SOURCE_META: Record<
  SourceType,
  {
    label: string;
    icon: ReactNode;
    placeholder: string;
    help: string;
    inputType?: "url" | "text" | "password";
  }
> = {
  git: {
    label: "Git URL",
    icon: <IconGitBranch size={14} />,
    placeholder: "https://github.com/owner/repo.git",
    help: "허용 호스트: github / gitlab / bitbucket / codeberg / sr.ht",
    inputType: "url",
  },
  folder: {
    label: "서버 폴더",
    icon: <IconFolder size={14} />,
    placeholder: "/workspace/projects/egov",
    help:
      "백엔드 서버가 직접 읽을 수 있는 절대경로. Windows라면 C:/Users/i/git/foo 식.",
  },
  url: {
    label: "API URL",
    icon: <IconGlobe size={14} />,
    placeholder: "https://api.example.com/items",
    help:
      "JSON 목록을 응답하는 HTTPS 엔드포인트. 아래 상세 키/URL을 채우면 " +
      "각 항목의 상세까지 가져오고, 비우면 이 응답만 인덱싱합니다.",
    inputType: "url",
  },
  connection: {
    label: "DB 연결",
    icon: <IconDatabase size={14} />,
    placeholder: "postgresql://user:pass@host:5432/dbname",
    help:
      "지원: postgresql / mysql / mariadb / sqlite. 읽기 전용 reflection만 수행합니다.",
    inputType: "password",
  },
  sftp: {
    label: "SFTP",
    icon: <IconGlobe size={14} />,
    placeholder: "",  // unused — sftp uses a custom multi-field form
    help: "원격 서버 정보를 입력하면 백엔드가 SFTP로 접속해 문서를 받아옵니다.",
  },
};

/** Hide credentials when rendering a project's source_ref. Both
 *  the DB connection string and SFTP URL embed user:password in the
 *  authority; replace the password section with "***". */
function maskSourceRef(sourceType: SourceType, ref: string): string {
  if (sourceType !== "connection" && sourceType !== "sftp") return ref;
  return ref.replace(
    /^([a-z][a-z0-9+.-]*):\/\/([^:@/]+):[^@]+@/i,
    "$1://$2:***@",
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Active chat session id, if any. When set, ready projects show an
   *  "이 채팅에 연결" / "✓ 연결됨" action. */
  linkSessionId?: string | null;
  /** Current linked project id for the session above, so we can mark
   *  the right card as active. */
  linkedProjectId?: string | null;
  /** Called when the user toggles the link from a project card. */
  onLinkChange?: (projectId: string | null) => void;
  /** When true (admin context), the add form exposes the "공유
   *  지식베이스" toggle + role-grant checkboxes, and project cards
   *  show the role-access editor. */
  adminMode?: boolean;
  /** When true, render inline (no modal backdrop / close button) so
   *  the panel sits inside the admin shell like the roles table. */
  embedded?: boolean;
  /** Open straight into the 추가 view (skip the browse list). */
  initialAddOpen?: boolean;
  /** Pre-select this project in the browse view so the card on the
   *  right shows its details / snapshots / edit form immediately. */
  initialProjectId?: string | null;
  /** Auto-expand the snapshot history panel on the focused project's
   *  card. Used by the admin table's "스냅샷" cell so a click jumps
   *  straight into the snapshot list. */
  initialSnapshotsOpen?: boolean;
}

function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function ProjectModal({
  open,
  onClose,
  linkSessionId = null,
  linkedProjectId = null,
  onLinkChange,
  adminMode = false,
  embedded = false,
  initialAddOpen = false,
  initialProjectId = null,
  initialSnapshotsOpen = false,
}: Props) {
  const { projects, storageBytes, create, remove, reindex, refresh } =
    useProjects();
  const [addOpen, setAddOpen] = useState(false);
  // Role catalog for the admin share-grant UI. Only fetched in admin
  // mode; non-admins can't hit /admin/roles anyway.
  const [roles, setRoles] = useState<Role[]>([]);
  useEffect(() => {
    if (open && adminMode) {
      admin.listRoles().then(setRoles).catch(() => undefined);
    }
  }, [open, adminMode]);
  // Master-detail: only one project's full card (status / snapshots /
  // schedule / actions) is rendered at a time. The list on the left
  // shows just name + status so the modal isn't a wall of expanded
  // history when the user just wants to switch projects.
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    refresh();
    // Embedded panel has no backdrop to dismiss — don't hijack ESC.
    if (embedded) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, refresh, embedded]);

  // Auto-open the add form when the list is empty (onboarding CTA)
  // OR when the parent explicitly asked via initialAddOpen. When the
  // parent passed initialProjectId (e.g., 관리 button on the admin
  // table), force browse view so the user actually sees the project's
  // card instead of a stale add form left over from a previous open.
  useEffect(() => {
    if (!open) return;
    if (initialAddOpen) {
      setAddOpen(true);
    } else if (initialProjectId) {
      setAddOpen(false);
    } else if (projects.length === 0) {
      setAddOpen(true);
    }
  }, [open, initialAddOpen, initialProjectId, projects.length]);

  // Honour initialProjectId so a "관리" button on a row card opens
  // the modal with that project already focused on the right.
  useEffect(() => {
    if (!open) return;
    if (initialProjectId) setActiveProjectId(initialProjectId);
  }, [open, initialProjectId]);

  // Default the detail pane to the linked project on open, falling
  // back to the first project so the right side is never empty when
  // any project exists. Also drop the selection when the active
  // project is deleted so the empty-state shows up instead of a
  // stale id.
  useEffect(() => {
    if (!open) return;
    if (projects.length === 0) {
      setActiveProjectId(null);
      return;
    }
    setActiveProjectId((curr) => {
      if (curr && projects.some((p) => p.id === curr)) return curr;
      if (linkedProjectId && projects.some((p) => p.id === linkedProjectId))
        return linkedProjectId;
      return projects[0].id;
    });
  }, [open, projects, linkedProjectId]);

  if (!open) return null;
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  // Embedded mode (admin "지식베이스" panel) drops the modal backdrop
  // + header chrome and renders the body inline inside the admin
  // shell — same pattern as the roles panel. Standalone mode keeps
  // the full modal for the sidebar entry point.
  const body = (
    <>

        {addOpen ? (
          // Add-only view — the modal's own ✕ closes it; no separate
          // back-to-list affordance since the parent page already
          // shows the list directly.
          <div className="pm-body pm-body-add">
            <div className="pm-add-header">
              <h4>새 RAG 프로젝트 추가</h4>
            </div>
            <div className="pm-add-wrap">
              <AddProjectForm
                compact={projects.length > 0}
                adminMode={adminMode}
                roles={roles}
                onCancel={
                  projects.length > 0 ? () => setAddOpen(false) : undefined
                }
                onSubmit={async (payload) => {
                  await create(payload);
                  setAddOpen(false);
                }}
              />
            </div>
          </div>
        ) : (
          // ── Browse view ── master-detail (list left, single card right)
          <div className="pm-body pm-body-browse">
            <aside className="pm-side">
              <button
                type="button"
                className="pm-add-cta pm-side-add"
                onClick={() => setAddOpen(true)}
              >
                <IconPlus size={14} />
                <span>새 프로젝트 추가</span>
              </button>
              {projects.length === 0 ? (
                <div className="pm-empty">
                  <IconBookOpen size={28} />
                  <p>아직 추가된 프로젝트가 없습니다.</p>
                </div>
              ) : (
                <ul className="pm-side-list">
                  {projects.map((p) => (
                    <ProjectListItem
                      key={p.id}
                      project={p}
                      active={p.id === activeProjectId}
                      linked={linkedProjectId === p.id}
                      onSelect={() => setActiveProjectId(p.id)}
                    />
                  ))}
                </ul>
              )}
            </aside>

            <main className="pm-detail">
              {activeProject ? (
                <ProjectCard
                  project={activeProject}
                  adminMode={adminMode}
                  allRoles={roles}
                  initialSnapshotsOpen={initialSnapshotsOpen}
                  linkable={!!linkSessionId}
                  linked={linkedProjectId === activeProject.id}
                  onLink={() =>
                    onLinkChange?.(
                      linkedProjectId === activeProject.id
                        ? null
                        : activeProject.id,
                    )
                  }
                  onReindex={() => reindex(activeProject.id)}
                  onDelete={async () => {
                    if (
                      !window.confirm(
                        `"${activeProject.name}"을(를) 삭제할까요?\n인덱스도 함께 사라지고 디스크 공간이 회수됩니다.`,
                      )
                    )
                      return;
                    if (linkedProjectId === activeProject.id)
                      onLinkChange?.(null);
                    try {
                      const { freedBytes } = await remove(activeProject.id);
                      if (freedBytes > 0) {
                        console.info(
                          `[RAG] "${activeProject.name}" 삭제 — ${fmtBytes(freedBytes)} 회수`,
                        );
                      }
                      // After deletion, refresh() runs in the hook;
                      // the effect above will pick a new active id.
                    } catch (e) {
                      window.alert(
                        `삭제 실패: ${e instanceof Error ? e.message : String(e)}`,
                      );
                    }
                  }}
                />
              ) : (
                <div className="pm-detail-empty">
                  왼쪽에서 프로젝트를 선택하세요.
                </div>
              )}
            </main>
          </div>
        )}
    </>
  );

  if (embedded) {
    return <div className="pm-embedded">{body}</div>;
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal projects-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="pm-head">
          <div className="pm-head-text">
            <h3>RAG 프로젝트</h3>
            <p>대용량 코드베이스를 한 번 인덱싱해 자연어로 검색·분석하세요.</p>
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
        {body}
      </div>
    </div>
  );
}

// ── Project list item (left side, compact row) ───────────────────────

function ProjectListItem({
  project: p,
  active,
  linked,
  onSelect,
}: {
  project: Project;
  active: boolean;
  linked: boolean;
  onSelect: () => void;
}) {
  const meta = CORPUS_META[p.corpus_type] ?? CORPUS_META.document;
  const statusText =
    p.status === "ready"
      ? "준비됨"
      : p.status === "indexing"
      ? p.progress_total
        ? `${Math.round((100 * p.progress_done) / p.progress_total)}%`
        : "인덱싱"
      : p.status === "failed"
      ? "실패"
      : "대기";
  return (
    <li
      className={`pm-side-item status-${p.status}${active ? " active" : ""}${
        linked ? " linked" : ""
      }`}
      onClick={onSelect}
    >
      <div className="pm-side-item-top">
        <span className="pm-side-item-icon" aria-hidden>
          {SOURCE_META[p.source_type]?.icon ?? <IconFolder size={13} />}
        </span>
        <span className="pm-side-item-name" title={p.name}>
          {p.name}
        </span>
        {linked && (
          <span className="pm-side-item-linked" title="현재 채팅에 연결됨">
            <IconCheck size={11} />
          </span>
        )}
      </div>
      <div className="pm-side-item-meta">
        <span className={`pm-side-item-corpus corpus-${p.corpus_type}`}>
          {meta.label}
        </span>
        <span className={`pm-side-item-status status-${p.status}`}>
          {statusText}
        </span>
      </div>
    </li>
  );
}

// ── Project card ─────────────────────────────────────────────────────

function ProjectCard({
  project: p,
  adminMode = false,
  allRoles = [],
  initialSnapshotsOpen = false,
  linkable,
  linked,
  onLink,
  onReindex,
  onDelete,
}: {
  project: Project;
  adminMode?: boolean;
  allRoles?: Role[];
  initialSnapshotsOpen?: boolean;
  linkable: boolean;
  linked: boolean;
  onLink: () => void;
  onReindex: () => void;
  onDelete: () => void;
}) {
  const {
    activateSnapshot,
    deleteSnapshot,
    refreshProject,
    setSchedule,
    update,
  } = useProjects();
  const [snapshotsOpen, setSnapshotsOpen] = useState(initialSnapshotsOpen);
  // Re-open if the parent flips the flag (e.g., the admin table's
  // 스냅샷 cell triggers a refocus on the same project).
  useEffect(() => {
    if (initialSnapshotsOpen) setSnapshotsOpen(true);
  }, [initialSnapshotsOpen, p.id]);
  // Edit mode — populated from the current project when the user
  // clicks 편집. Save = PATCH, then refresh; cancel reverts.
  const [editing, setEditing] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [eName, setEName] = useState(p.name);
  const [eSourceRef, setESourceRef] = useState(p.source_ref);
  const [eSql, setESql] = useState(p.sql_query ?? "");
  const [eApiKey, setEApiKey] = useState(p.api_detail_key ?? "");
  const [eApiUrl, setEApiUrl] = useState(p.api_detail_url ?? "");
  const [eShared, setEShared] = useState(p.is_shared);
  const [eRoles, setERoles] = useState<Set<string>>(new Set(p.role_codes));

  // Re-seed every time the project under the card changes (user
  // switched projects, snapshot landed, etc.) so we don't keep stale
  // edit state from a previous selection.
  useEffect(() => {
    if (editing) return;
    setEName(p.name);
    setESourceRef(p.source_ref);
    setESql(p.sql_query ?? "");
    setEApiKey(p.api_detail_key ?? "");
    setEApiUrl(p.api_detail_url ?? "");
    setEShared(p.is_shared);
    setERoles(new Set(p.role_codes));
  }, [
    p.id, p.name, p.source_ref, p.sql_query, p.api_detail_key,
    p.api_detail_url, p.is_shared, p.role_codes, editing,
  ]);

  async function saveEdit() {
    setEditBusy(true);
    setEditErr(null);
    try {
      const payload: Parameters<typeof update>[1] = {};
      if (eName.trim() !== p.name) payload.name = eName.trim();
      if (eSourceRef.trim() !== p.source_ref) payload.source_ref = eSourceRef.trim();
      if (p.source_type === "connection") {
        const next = eSql.trim() || null;
        if (next !== (p.sql_query ?? null)) payload.sql_query = next;
      }
      if (p.source_type === "url") {
        const k = eApiKey.trim() || null;
        const u = eApiUrl.trim() || null;
        if (k !== (p.api_detail_key ?? null)) payload.api_detail_key = k;
        if (u !== (p.api_detail_url ?? null)) payload.api_detail_url = u;
      }
      if (adminMode) {
        if (eShared !== p.is_shared) payload.is_shared = eShared;
        const cur = new Set(p.role_codes);
        const sameSize = cur.size === eRoles.size;
        const sameMembers = sameSize && [...cur].every((c) => eRoles.has(c));
        if (!sameMembers) payload.role_codes = Array.from(eRoles);
      }
      if (Object.keys(payload).length === 0) {
        setEditing(false);
        return;
      }
      await update(p.id, payload);
      setEditing(false);
    } catch (e) {
      setEditErr(
        e instanceof Error ? e.message.replace(/^\d+\s/, "") : "저장 실패",
      );
    } finally {
      setEditBusy(false);
    }
  }
  const pct =
    p.status === "indexing" && p.progress_total
      ? Math.round((100 * p.progress_done) / p.progress_total)
      : 0;
  const totalSnapshots = p.snapshots?.length ?? 0;
  const currentSnapshot = p.snapshots?.find(
    (s) => s.id === p.current_snapshot_id,
  );

  const meta = CORPUS_META[p.corpus_type] ?? CORPUS_META.document;
  const isLegacyCode = p.corpus_type === "code";
  return (
    <article className={`pm-card status-${p.status}${linked ? " linked" : ""}`}>
      <div className="pm-card-head">
        <div className="pm-card-title">
          <span className="pm-card-icon" aria-hidden>
            {SOURCE_META[p.source_type]?.icon ?? <IconFolder size={14} />}
          </span>
          <span className="pm-card-name" title={p.name}>{p.name}</span>
          <span
            className={`pm-corpus-chip corpus-${p.corpus_type}${isLegacyCode ? " legacy" : ""}`}
            title={
              isLegacyCode
                ? "코드 코퍼스는 Code 탭으로 이전됨 (기존 데이터는 그대로 사용 가능)"
                : meta.hint
            }
          >
            <span className="pm-corpus-chip-icon" aria-hidden>
              {meta.icon}
            </span>
            {meta.label}
            {isLegacyCode && (
              <span className="pm-corpus-legacy-tag">legacy</span>
            )}
          </span>
          {linked && (
            <span className="pm-card-linked-badge" title="현재 채팅에 연결됨">
              <IconCheck size={11} /> 현재 채팅
            </span>
          )}
        </div>
        <StatusBadge status={p.status} />
      </div>

      <div
        className="pm-card-source"
        title={maskSourceRef(p.source_type, p.source_ref)}
      >
        {maskSourceRef(p.source_type, p.source_ref)}
      </div>

      {p.status === "indexing" && (
        <div className="pm-card-progress">
          <div className="pm-progress-bar">
            <div className="pm-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="pm-progress-text">
            {p.progress_done.toLocaleString()} / {p.progress_total.toLocaleString()} 청크 ({pct}%)
          </div>
        </div>
      )}

      {p.status === "ready" && (
        <div className="pm-card-stats">
          <span className="pm-stat">
            <span className="pm-stat-num">{p.file_count.toLocaleString()}</span>
            <span className="pm-stat-label">파일</span>
          </span>
          <span className="pm-stat-sep" aria-hidden>·</span>
          <span className="pm-stat">
            <span className="pm-stat-num">{p.chunk_count.toLocaleString()}</span>
            <span className="pm-stat-label">청크</span>
          </span>
        </div>
      )}

      {p.status === "failed" && p.error && (
        <div className="pm-card-error">
          <IconAlertTriangle size={14} />
          <span>{p.error}</span>
        </div>
      )}

      {totalSnapshots > 0 && (
        <div className="pm-snap-block">
          <button
            type="button"
            className="pm-snap-toggle"
            onClick={() => setSnapshotsOpen((v) => !v)}
            aria-expanded={snapshotsOpen}
          >
            <span aria-hidden>
              {snapshotsOpen ? (
                <IconChevronDown size={14} />
              ) : (
                <IconChevronRight size={14} />
              )}
            </span>
            <IconHistory size={14} />
            <span>
              스냅샷 {totalSnapshots}개
              {currentSnapshot && (
                <span className="pm-snap-current-label">
                  &nbsp;· 현재 {currentSnapshot.label}
                </span>
              )}
            </span>
          </button>
          {snapshotsOpen && (
            <ul className="pm-snap-list">
              {p.snapshots
                .slice()
                .sort(
                  (a, b) =>
                    new Date(b.created_at).getTime() -
                    new Date(a.created_at).getTime(),
                )
                .map((s) => {
                  const isCurrent = s.id === p.current_snapshot_id;
                  return (
                    <li
                      key={s.id}
                      className={`pm-snap-item status-${s.status}${
                        isCurrent ? " current" : ""
                      }`}
                    >
                      <div className="pm-snap-main">
                        <div className="pm-snap-label">
                          {s.label || s.id.slice(0, 8)}
                          {isCurrent && (
                            <span className="pm-snap-current-pill">현재</span>
                          )}
                        </div>
                        <div className="pm-snap-meta">
                          <span className={`pm-snap-status status-${s.status}`}>
                            {s.status === "ready"
                              ? "준비됨"
                              : s.status === "indexing"
                              ? `인덱싱 ${
                                  s.progress_total
                                    ? Math.round(
                                        (100 * s.progress_done) /
                                          s.progress_total,
                                      )
                                    : 0
                                }%`
                              : s.status === "failed"
                              ? "실패"
                              : "대기"}
                          </span>
                          {s.status === "ready" && (
                            <>
                              <span aria-hidden>·</span>
                              <span>
                                {s.file_count}f / {s.chunk_count}c
                              </span>
                            </>
                          )}
                          <span aria-hidden>·</span>
                          <span className="pm-snap-time">
                            {new Date(s.created_at).toLocaleString()}
                          </span>
                        </div>
                      </div>
                      <div className="pm-snap-actions">
                        {!isCurrent && s.status === "ready" && (
                          <button
                            type="button"
                            className="pm-snap-btn"
                            onClick={() => activateSnapshot(p.id, s.id)}
                            title="이 스냅샷을 현재로 설정"
                          >
                            현재로
                          </button>
                        )}
                        {totalSnapshots > 1 && (
                          <button
                            type="button"
                            className="pm-snap-btn danger"
                            onClick={async () => {
                              if (
                                window.confirm(
                                  `스냅샷 "${s.label}"을(를) 삭제할까요?`,
                                )
                              ) {
                                await deleteSnapshot(p.id, s.id).catch(
                                  (err) =>
                                    window.alert(
                                      `삭제 실패: ${
                                        err instanceof Error
                                          ? err.message
                                          : String(err)
                                      }`,
                                    ),
                                );
                              }
                            }}
                            title="이 스냅샷만 삭제"
                          >
                            <IconTrash size={13} />
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
            </ul>
          )}
        </div>
      )}

      {p.status === "ready" && (
        <ScheduleBlock
          project={p}
          onRefreshNow={() => refreshProject(p.id)}
          onSetSchedule={(mins) => setSchedule(p.id, mins)}
        />
      )}

      <div className="pm-card-actions">
        {linkable && p.status === "ready" && (
          <button
            type="button"
            className={`pm-link-btn${linked ? " linked" : ""}`}
            onClick={onLink}
          >
            {linked ? (
              <>
                <IconCheck size={14} />
                <span>연결됨</span>
              </>
            ) : (
              <span>이 채팅에 연결</span>
            )}
          </button>
        )}
        {p.owned && (p.status === "ready" || p.status === "failed") && (
          <button
            type="button"
            className="pm-icon-btn"
            onClick={onReindex}
            title="새 스냅샷으로 다시 인덱싱 (이전 스냅샷 유지)"
            aria-label="다시 인덱싱"
          >
            <IconRefresh size={15} />
          </button>
        )}
        {(p.owned || adminMode) && (
          <button
            type="button"
            className="pm-icon-btn"
            onClick={() => setEditing((v) => !v)}
            title={editing ? "편집 취소" : "편집"}
            aria-label="편집"
          >
            {editing ? <IconX size={15} /> : <IconCode size={15} />}
          </button>
        )}
        {p.owned ? (
          <button
            type="button"
            className="pm-icon-btn danger"
            onClick={onDelete}
            title="삭제"
            aria-label="삭제"
          >
            <IconTrash size={15} />
          </button>
        ) : (
          <span className="pm-shared-badge" title="공유 지식베이스 — 읽기 전용">
            공유
          </span>
        )}
      </div>

      {editing && (
        <div className="pm-edit-form">
          <div className="pm-field">
            <label htmlFor={`pm-edit-name-${p.id}`}>이름</label>
            <input
              id={`pm-edit-name-${p.id}`}
              type="text"
              value={eName}
              onChange={(e) => setEName(e.target.value)}
              disabled={editBusy}
              maxLength={120}
            />
          </div>
          <div className="pm-field">
            <label htmlFor={`pm-edit-ref-${p.id}`}>
              {p.source_type === "url"
                ? "목록 API URL"
                : p.source_type === "git"
                ? "Git URL"
                : p.source_type === "folder"
                ? "서버 폴더"
                : p.source_type === "connection"
                ? "DB 연결 문자열"
                : p.source_type === "sftp"
                ? "SFTP URL"
                : "출처"}
            </label>
            <input
              id={`pm-edit-ref-${p.id}`}
              type="text"
              value={eSourceRef}
              onChange={(e) => setESourceRef(e.target.value)}
              disabled={editBusy}
              maxLength={500}
            />
            <div className="pm-help">
              값을 바꾸면 기존 인덱스가 오래된 상태로 표시되고,
              저장 즉시 새 스냅샷이 시작됩니다.
            </div>
          </div>

          {p.source_type === "connection" && (
            <div className="pm-field">
              <label htmlFor={`pm-edit-sql-${p.id}`}>조회 SQL</label>
              <textarea
                id={`pm-edit-sql-${p.id}`}
                className="pm-db-sql-textarea"
                value={eSql}
                onChange={(e) => setESql(e.target.value)}
                disabled={editBusy}
                rows={5}
                spellCheck={false}
              />
              <div className="pm-help">
                SELECT/WITH 만 허용. 비우면 스키마만 인덱싱.
              </div>
            </div>
          )}

          {p.source_type === "url" && (
            <>
              <div className="pm-field">
                <label htmlFor={`pm-edit-apik-${p.id}`}>상세 키</label>
                <input
                  id={`pm-edit-apik-${p.id}`}
                  type="text"
                  value={eApiKey}
                  onChange={(e) => setEApiKey(e.target.value)}
                  disabled={editBusy}
                />
              </div>
              <div className="pm-field">
                <label htmlFor={`pm-edit-apiu-${p.id}`}>
                  상세 URL 템플릿
                </label>
                <input
                  id={`pm-edit-apiu-${p.id}`}
                  type="text"
                  value={eApiUrl}
                  onChange={(e) => setEApiUrl(e.target.value)}
                  disabled={editBusy}
                />
              </div>
            </>
          )}

          {adminMode && (
            <div className="pm-field pm-share-field">
              <label className="pm-share-toggle">
                <input
                  type="checkbox"
                  checked={eShared}
                  onChange={(e) => setEShared(e.target.checked)}
                  disabled={editBusy}
                />
                <span>
                  <b>공유 지식베이스</b>
                  <span className="pm-help">
                    체크 시 아래 역할 사용자가 채팅에서 자동 활용
                  </span>
                </span>
              </label>
              {eShared && (
                <div className="pm-share-roles">
                  <div className="pm-share-role-grid">
                    {allRoles.map((r) => (
                      <label key={r.code} className="pm-share-role-chip">
                        <input
                          type="checkbox"
                          checked={eRoles.has(r.code)}
                          onChange={(e) =>
                            setERoles((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(r.code);
                              else next.delete(r.code);
                              return next;
                            })
                          }
                          disabled={editBusy}
                        />
                        <span>{r.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {editErr && (
            <div className="pm-add-error">
              <IconAlertTriangle size={14} />
              <span>{editErr}</span>
            </div>
          )}
          <div className="pm-edit-actions">
            <button
              type="button"
              className="pm-btn-primary"
              onClick={saveEdit}
              disabled={editBusy}
            >
              {editBusy ? "저장 중…" : "저장"}
            </button>
            <button
              type="button"
              className="pm-btn-secondary"
              onClick={() => {
                setEditing(false);
                setEditErr(null);
              }}
              disabled={editBusy}
            >
              취소
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

// ── Status badge ─────────────────────────────────────────────────────

function ScheduleBlock({
  project,
  onRefreshNow,
  onSetSchedule,
}: {
  project: Project;
  onRefreshNow: () => Promise<void> | void;
  onSetSchedule: (intervalMinutes: number) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const current = project.schedule_interval_minutes;
  const presets: { label: string; mins: number }[] = [
    { label: "끔", mins: 0 },
    { label: "10분", mins: 10 },
    { label: "30분", mins: 30 },
    { label: "1시간", mins: 60 },
    { label: "6시간", mins: 60 * 6 },
    { label: "1일", mins: 60 * 24 },
  ];
  return (
    <div className="pm-sched-block">
      <div className="pm-sched-row">
        <span className="pm-sched-label">
          <IconClock size={13} /> 자동 새로고침
        </span>
        <div className="pm-sched-presets">
          {presets.map((p) => (
            <button
              key={p.mins}
              type="button"
              className={`pm-sched-pill${current === p.mins ? " active" : ""}`}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onSetSchedule(p.mins);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {current > 0 && (
        <div className="pm-sched-row pm-sched-hint">
          <span className="pm-help">
            {current >= 1440
              ? "매일 새벽에 자동 갱신됩니다."
              : current === 60
              ? "매시 정각(00분)에 자동 갱신됩니다."
              : current < 60
              ? `정시 기준 ${current}분 간격(예: 00분, ${current}분…)으로 갱신됩니다.`
              : `정시 기준 ${current / 60}시간 간격으로 갱신됩니다.`}
          </span>
        </div>
      )}
      <div className="pm-sched-row pm-sched-meta">
        <span>
          {project.last_indexed_at
            ? `최근 인덱싱: ${new Date(project.last_indexed_at).toLocaleString()}`
            : "최근 인덱싱: —"}
        </span>
        <button
          type="button"
          className="pm-sched-refresh"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onRefreshNow();
            } finally {
              setBusy(false);
            }
          }}
        >
          <IconRefresh size={12} /> 지금 새로고침
        </button>
      </div>
    </div>
  );
}


function StatusBadge({ status }: { status: Project["status"] }) {
  const map = {
    ready: {
      icon: <IconCheckCircle size={12} />,
      label: "준비됨",
      cls: "ready",
    },
    indexing: {
      icon: <IconRefresh size={12} className="pm-spin" />,
      label: "인덱싱 중",
      cls: "indexing",
    },
    pending: { icon: <IconClock size={12} />, label: "대기", cls: "pending" },
    failed: {
      icon: <IconAlertTriangle size={12} />,
      label: "실패",
      cls: "failed",
    },
  } as const;
  const s = map[status];
  return (
    <span className={`pm-badge ${s.cls}`}>
      {s.icon}
      {s.label}
    </span>
  );
}

// ── Add-project form ─────────────────────────────────────────────────

function AddProjectForm({
  compact,
  adminMode = false,
  roles = [],
  onCancel,
  onSubmit,
}: {
  compact: boolean;
  adminMode?: boolean;
  roles?: Role[];
  onCancel?: () => void;
  onSubmit: (payload: {
    name: string;
    source_type: SourceType;
    source_ref: string;
    ref?: string;
    corpus_type: CorpusType;
    sql_query?: string | null;
    api_detail_key?: string | null;
    api_detail_url?: string | null;
    is_shared?: boolean;
    role_codes?: string[];
  }) => Promise<void>;
}) {
  // Shared knowledge-base toggle + role grants (admin only). Default
  // ON in admin mode — knowledge bases created from the admin panel
  // are shared by intent; the operator unchecks for a private one.
  const [isShared, setIsShared] = useState(adminMode);
  const [shareRoles, setShareRoles] = useState<Set<string>>(new Set());
  // API list→detail collection (url source). Empty = plain spec fetch.
  const [apiDetailKey, setApiDetailKey] = useState("");
  const [apiDetailUrl, setApiDetailUrl] = useState("");
  const [apiPreview, setApiPreview] = useState<{
    ok: boolean;
    error?: string;
    total?: number;
    sampled?: number;
    records?: { _key: string; _url: string; _body: unknown }[];
  } | null>(null);
  const [apiPreviewing, setApiPreviewing] = useState(false);
  // Code corpus moved to the Code tab; new Cowork projects default
  // to "document". CORPUS_META still keeps the "code" entry so legacy
  // chips render, but the tabs no longer expose it.
  const [corpusType, setCorpusType] = useState<CorpusType>("document");
  const [sourceType, setSourceType] = useState<SourceType>(
    CORPUS_META.document.sources[0],
  );
  // One input value per source type so switching the source tab
  // doesn't wipe what the user already typed in another tab.
  const [refs, setRefs] = useState<Record<SourceType, string>>({
    git: "",
    folder: "",
    url: "",
    connection: "",
    sftp: "",  // unused — sftp uses the multi-field form below
  });
  // SFTP fields (5) — combined into a sftp:// URL on submit so the
  // backend sees the same shape as the rest of the source types.
  const [sftpHost, setSftpHost] = useState("");
  const [sftpPort, setSftpPort] = useState("22");
  const [sftpUser, setSftpUser] = useState("");
  const [sftpPass, setSftpPass] = useState("");
  const [sftpPath, setSftpPath] = useState("/");
  // DB connection driver + per-driver field state. The catalog comes
  // from /api/projects/_db-drivers so backend-side driver registry is
  // the source of truth for labels / default ports / file-based flag.
  const [dbDrivers, setDbDrivers] = useState<DbDriverInfo[]>([]);
  const [dbDriver, setDbDriver] = useState<string>("postgresql");
  const [dbHost, setDbHost] = useState("");
  const [dbPort, setDbPort] = useState("");
  const [dbUser, setDbUser] = useState("");
  const [dbPass, setDbPass] = useState("");
  const [dbDatabase, setDbDatabase] = useState("");
  const [dbTest, setDbTest] = useState<DbTestResult | null>(null);
  const [dbTesting, setDbTesting] = useState(false);
  // Optional SELECT — when filled the indexer runs it on every
  // snapshot and embeds the row set alongside the schema dump. The
  // textarea + preview button only render for source_type='connection'.
  const [dbSql, setDbSql] = useState("");
  const [dbSqlPreview, setDbSqlPreview] = useState<SqlPreviewResult | null>(null);
  const [dbSqlPreviewing, setDbSqlPreviewing] = useState(false);
  const [name, setName] = useState("");
  const [gitBranch, setGitBranch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Load the driver catalog once. Failures keep the form usable —
  // the picker just falls back to the static default list below.
  useEffect(() => {
    api.listDbDrivers().then(setDbDrivers).catch(() => undefined);
  }, []);

  const currentDriver = useMemo(
    () => dbDrivers.find((d) => d.code === dbDriver),
    [dbDrivers, dbDriver],
  );

  // Snap the port placeholder to the driver's default whenever the
  // user switches drivers, but only if they hadn't typed anything yet
  // (don't blow away a user-entered port).
  function onDbDriverChange(code: string) {
    setDbDriver(code);
    setDbTest(null);
    const next = dbDrivers.find((d) => d.code === code);
    if (next && !dbPort) {
      // No-op — just leaves the placeholder showing the default.
    }
    if (next?.is_file_based) {
      // Clear network fields so they don't get auto-submitted into a
      // sqlite URL by accident.
      setDbHost("");
      setDbPort("");
      setDbUser("");
      setDbPass("");
    }
  }
  const [error, setError] = useState<string | null>(null);

  // When the corpus tab changes, snap the source picker to a value
  // that's actually allowed for that corpus.
  function onCorpusChange(t: CorpusType) {
    setCorpusType(t);
    const allowed = CORPUS_META[t].sources;
    if (!allowed.includes(sourceType)) {
      setSourceType(allowed[0]);
    }
  }

  const sourceMeta = SOURCE_META[sourceType];
  const corpusMeta = CORPUS_META[corpusType];

  /** Mirror of backend `db_drivers.build_db_url` so what the frontend
   *  submits matches exactly what the test endpoint produces. Keep
   *  these two in sync — the backend file is the canonical reference. */
  function buildDbUrl(): string {
    const info = currentDriver;
    if (!info) return "";
    if (info.is_file_based) {
      const path = dbDatabase.trim();
      if (!path) return "sqlite:///:memory:";
      if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
        return `sqlite:///${path}`;
      }
      return `sqlite:///./${path}`;
    }
    const schemeMap: Record<string, string> = {
      postgresql: "postgresql+psycopg2",
      mysql: "mysql+pymysql",
      mariadb: "mariadb+pymysql",
      mssql: "mssql+pyodbc",
      tibero: "tibero+pyodbc",
      cubrid: "cubrid",
      altibase: "altibase+pyodbc",
    };
    const scheme = schemeMap[info.code] || info.code;
    const portNum = dbPort.trim() ? Number(dbPort.trim()) : info.default_port;
    const u = encodeURIComponent(dbUser);
    const p = encodeURIComponent(dbPass);
    const auth = u ? (p ? `${u}:${p}@` : `${u}@`) : "";
    const hostPart = portNum ? `${dbHost}:${portNum}` : dbHost;
    const dbPart = dbDatabase ? `/${encodeURIComponent(dbDatabase)}` : "";
    let url = `${scheme}://${auth}${hostPart}${dbPart}`;
    if (info.code === "mssql") {
      url += "?driver=ODBC+Driver+17+for+SQL+Server";
    } else if (info.code === "tibero") {
      url += "?driver=Tibero";
    }
    return url;
  }

  async function runApiPreview() {
    if (apiPreviewing) return;
    if (!apiDetailKey.trim() || !apiDetailUrl.trim()) {
      setApiPreview({ ok: false, error: "상세 키와 상세 URL을 모두 입력하세요" });
      return;
    }
    const listUrl = (refs.url || "").trim();
    if (!listUrl) {
      setApiPreview({ ok: false, error: "목록 API URL을 먼저 입력하세요" });
      return;
    }
    setApiPreviewing(true);
    setApiPreview(null);
    try {
      const res = await api.previewApiDetails({
        list_url: listUrl,
        detail_key: apiDetailKey.trim(),
        detail_url: apiDetailUrl.trim(),
        limit: 3,
      });
      setApiPreview(res);
    } catch (e) {
      setApiPreview({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setApiPreviewing(false);
    }
  }

  async function runDbSqlPreview() {
    if (dbSqlPreviewing) return;
    if (!dbSql.trim()) {
      setDbSqlPreview({
        ok: false,
        columns: [],
        rows: [],
        row_count: 0,
        truncated: false,
        error: "SQL을 입력하세요",
      });
      return;
    }
    setDbSqlPreviewing(true);
    setDbSqlPreview(null);
    try {
      const result = await api.previewDbSql({
        driver: dbDriver,
        host: dbHost,
        port: dbPort.trim() ? Number(dbPort.trim()) : null,
        user: dbUser,
        password: dbPass,
        database: dbDatabase,
        sql: dbSql.trim(),
        limit: 20,
      });
      setDbSqlPreview(result);
    } catch (e) {
      setDbSqlPreview({
        ok: false,
        columns: [],
        rows: [],
        row_count: 0,
        truncated: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setDbSqlPreviewing(false);
    }
  }

  async function runDbTest() {
    if (dbTesting) return;
    setDbTesting(true);
    setDbTest(null);
    try {
      const result = await api.testDbConnection({
        driver: dbDriver,
        host: dbHost,
        port: dbPort.trim() ? Number(dbPort.trim()) : null,
        user: dbUser,
        password: dbPass,
        database: dbDatabase,
      });
      setDbTest(result);
    } catch (e) {
      setDbTest({
        ok: false,
        driver: dbDriver,
        url_redacted: "",
        error: e instanceof Error ? e.message : String(e),
        table_count: null,
      });
    } finally {
      setDbTesting(false);
    }
  }

  function buildSftpUrl(): string {
    const host = sftpHost.trim();
    const user = sftpUser.trim();
    const port = sftpPort.trim() || "22";
    const path = sftpPath.trim() || "/";
    if (!host) return "";
    if (!user) return "";
    const encUser = encodeURIComponent(user);
    const encPass = encodeURIComponent(sftpPass);
    const encPath = path.startsWith("/") ? path : "/" + path;
    const auth = sftpPass ? `${encUser}:${encPass}` : encUser;
    return `sftp://${auth}@${host}:${port}${encPath}`;
  }

  async function submit() {
    setError(null);
    let sourceRef = "";
    if (sourceType === "sftp") {
      if (!sftpHost.trim()) {
        setError("SFTP 호스트를 입력하세요");
        return;
      }
      if (!sftpUser.trim()) {
        setError("SFTP 사용자명을 입력하세요");
        return;
      }
      sourceRef = buildSftpUrl();
    } else if (sourceType === "connection") {
      const info = currentDriver;
      if (!info) {
        setError("DB 드라이버를 선택하세요");
        return;
      }
      if (info.is_file_based) {
        if (!dbDatabase.trim()) {
          setError("DB 파일 경로를 입력하세요");
          return;
        }
      } else {
        if (!dbHost.trim()) {
          setError("호스트를 입력하세요");
          return;
        }
        if (!dbUser.trim()) {
          setError("사용자명을 입력하세요");
          return;
        }
        if (!dbDatabase.trim()) {
          setError("데이터베이스 이름을 입력하세요");
          return;
        }
      }
      sourceRef = buildDbUrl();
    } else {
      sourceRef = (refs[sourceType] || "").trim();
      if (!sourceRef) {
        setError(`${sourceMeta.label}을(를) 입력하세요`);
        return;
      }
    }
    if (!name.trim()) {
      setError("프로젝트 이름을 입력하세요");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        source_type: sourceType,
        source_ref: sourceRef,
        ref:
          sourceType === "git" && gitBranch.trim()
            ? gitBranch.trim()
            : undefined,
        corpus_type: corpusType,
        sql_query:
          sourceType === "connection" && dbSql.trim()
            ? dbSql.trim()
            : null,
        api_detail_key:
          sourceType === "url" && apiDetailKey.trim()
            ? apiDetailKey.trim()
            : null,
        api_detail_url:
          sourceType === "url" && apiDetailUrl.trim()
            ? apiDetailUrl.trim()
            : null,
        is_shared: adminMode ? isShared : false,
        role_codes: adminMode && isShared ? Array.from(shareRoles) : [],
      });
      setName("");
      setRefs({ git: "", folder: "", url: "", connection: "", sftp: "" });
      setGitBranch("");
      setSftpHost("");
      setSftpPort("22");
      setSftpUser("");
      setSftpPass("");
      setSftpPath("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={`pm-add ${compact ? "compact" : "hero"}`}>
      {!compact && (
        <header className="pm-add-hero">
          <div className="pm-add-hero-icon" aria-hidden>
            <IconBookOpen size={36} />
          </div>
          <h4>첫 프로젝트를 추가해보세요</h4>
          <p>
            코퍼스 유형을 고르면 그에 맞는 연결 방식을 선택할 수 있습니다.
            (문서는 SFTP/폴더, API는 OpenAPI URL, DB는 연결 문자열 …)
          </p>
          <p className="pm-add-hero-aside">
            코드 분석·수정 흐름은 사이드바의 <b>Code 탭</b>(워크스페이스)에서
            관리합니다.
          </p>
        </header>
      )}

      <div className="pm-field">
        <label>코퍼스 유형</label>
        <div className="pm-corpus-tabs" role="tablist">
          {(["document", "api", "db"] as const).map((t) => {
            const m = CORPUS_META[t];
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={corpusType === t}
                className={corpusType === t ? "active" : ""}
                onClick={() => onCorpusChange(t)}
              >
                <span aria-hidden>{m.icon}</span>
                <span>{m.label}</span>
              </button>
            );
          })}
        </div>
        <div className="pm-help">
          {corpusMeta.hint}
          <br />
          <span className="pm-help-aside">
            💡 코드 분석·수정은 사이드바의 <b>Code 탭</b>(워크스페이스)로
            이동했습니다.
          </span>
        </div>
      </div>

      <div className="pm-field">
        <label>연결 방식</label>
        <div className="pm-source-tabs" role="tablist">
          {corpusMeta.sources.map((st) => {
            const m = SOURCE_META[st];
            return (
              <button
                key={st}
                type="button"
                role="tab"
                aria-selected={sourceType === st}
                className={sourceType === st ? "active" : ""}
                onClick={() => setSourceType(st)}
              >
                {m.icon} {m.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="pm-field">
        <label htmlFor="pm-name">프로젝트 이름</label>
        <input
          id="pm-name"
          type="text"
          placeholder="예: 전자정부 표준프레임워크"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
        />
      </div>

      {sourceType === "sftp" ? (
        <div className="pm-sftp-grid">
          <div className="pm-field" style={{ gridColumn: "1 / span 2" }}>
            <label htmlFor="pm-sftp-host">호스트</label>
            <input
              id="pm-sftp-host"
              type="text"
              placeholder="files.internal.example.com"
              value={sftpHost}
              onChange={(e) => setSftpHost(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="pm-field">
            <label htmlFor="pm-sftp-port">포트</label>
            <input
              id="pm-sftp-port"
              type="number"
              placeholder="22"
              value={sftpPort}
              onChange={(e) => setSftpPort(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="pm-field">
            <label htmlFor="pm-sftp-user">사용자명</label>
            <input
              id="pm-sftp-user"
              type="text"
              autoComplete="username"
              value={sftpUser}
              onChange={(e) => setSftpUser(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="pm-field" style={{ gridColumn: "1 / span 2" }}>
            <label htmlFor="pm-sftp-pass">비밀번호</label>
            <input
              id="pm-sftp-pass"
              type="password"
              autoComplete="new-password"
              value={sftpPass}
              onChange={(e) => setSftpPass(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="pm-field" style={{ gridColumn: "1 / span 2" }}>
            <label htmlFor="pm-sftp-path">원격 경로</label>
            <input
              id="pm-sftp-path"
              type="text"
              placeholder="/srv/docs/manuals"
              value={sftpPath}
              onChange={(e) => setSftpPath(e.target.value)}
              disabled={submitting}
            />
            <div className="pm-help">
              백엔드가 이 경로 이하 트리를 재귀적으로 받아옵니다 (.pdf /
              .docx / .md / .txt …). 깊이 8단까지, RAG_MAX_FILES 한도.
            </div>
          </div>
        </div>
      ) : sourceType === "connection" ? (
        <div className="pm-db-form">
          <div className="pm-field">
            <label htmlFor="pm-db-driver">드라이버</label>
            <select
              id="pm-db-driver"
              className="pm-db-driver-select"
              value={dbDriver}
              onChange={(e) => onDbDriverChange(e.target.value)}
              disabled={submitting}
            >
              {(dbDrivers.length > 0
                ? dbDrivers
                : [
                    { code: "postgresql", label: "PostgreSQL" },
                    { code: "mysql", label: "MySQL" },
                    { code: "mariadb", label: "MariaDB" },
                    { code: "sqlite", label: "SQLite" },
                    { code: "mssql", label: "Microsoft SQL Server" },
                    { code: "tibero", label: "Tibero" },
                    { code: "cubrid", label: "CUBRID" },
                    { code: "altibase", label: "Altibase" },
                  ]
              ).map((d) => (
                <option key={d.code} value={d.code}>
                  {d.label}
                </option>
              ))}
            </select>
            {currentDriver?.notes && (
              <div className="pm-help">{currentDriver.notes}</div>
            )}
          </div>

          {currentDriver?.is_file_based ? (
            <div className="pm-field">
              <label htmlFor="pm-db-file">DB 파일 경로</label>
              <input
                id="pm-db-file"
                type="text"
                placeholder={
                  currentDriver.default_database || "/path/to/db.sqlite"
                }
                value={dbDatabase}
                onChange={(e) => setDbDatabase(e.target.value)}
                disabled={submitting}
                autoComplete="off"
              />
              <div className="pm-help">
                백엔드 서버에서 직접 읽을 수 있는 절대경로. 비워두면
                in-memory SQLite로 빈 스키마가 됩니다.
              </div>
            </div>
          ) : (
            <div className="pm-db-grid">
              <div className="pm-field pm-db-host">
                <label htmlFor="pm-db-host">호스트</label>
                <input
                  id="pm-db-host"
                  type="text"
                  placeholder="db.internal.example.com"
                  value={dbHost}
                  onChange={(e) => setDbHost(e.target.value)}
                  disabled={submitting}
                  autoComplete="off"
                />
              </div>
              <div className="pm-field pm-db-port">
                <label htmlFor="pm-db-port">포트</label>
                <input
                  id="pm-db-port"
                  type="number"
                  placeholder={String(currentDriver?.default_port ?? "")}
                  value={dbPort}
                  onChange={(e) => setDbPort(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <div className="pm-field pm-db-user">
                <label htmlFor="pm-db-user">사용자명</label>
                <input
                  id="pm-db-user"
                  type="text"
                  autoComplete="off"
                  value={dbUser}
                  onChange={(e) => setDbUser(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <div className="pm-field pm-db-pass">
                <label htmlFor="pm-db-pass">비밀번호</label>
                <input
                  id="pm-db-pass"
                  type="password"
                  autoComplete="new-password"
                  value={dbPass}
                  onChange={(e) => setDbPass(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <div className="pm-field pm-db-database">
                <label htmlFor="pm-db-database">데이터베이스 이름</label>
                <input
                  id="pm-db-database"
                  type="text"
                  placeholder={
                    currentDriver?.default_database || "예: mydb / SID / 서비스명"
                  }
                  value={dbDatabase}
                  onChange={(e) => setDbDatabase(e.target.value)}
                  disabled={submitting}
                  autoComplete="off"
                />
              </div>
            </div>
          )}

          <div className="pm-db-test-row">
            <button
              type="button"
              className="pm-btn-secondary"
              onClick={runDbTest}
              disabled={dbTesting || submitting}
            >
              {dbTesting ? "테스트 중…" : "접속 테스트"}
            </button>
            {dbTest && (
              <div
                className={
                  "pm-db-test-result " +
                  (dbTest.ok ? "pm-db-test-ok" : "pm-db-test-err")
                }
              >
                {dbTest.ok ? (
                  <>
                    <IconCheckCircle size={14} />
                    <span>
                      접속 성공
                      {typeof dbTest.table_count === "number"
                        ? ` · 테이블 ${dbTest.table_count}개 발견`
                        : ""}
                    </span>
                  </>
                ) : (
                  <>
                    <IconAlertTriangle size={14} />
                    <span>{dbTest.error || "접속 실패"}</span>
                  </>
                )}
              </div>
            )}
          </div>

          {dbTest?.url_redacted && (
            <div className="pm-help">
              연결 문자열: <code>{dbTest.url_redacted}</code>
            </div>
          )}

          <div className="pm-field">
            <label htmlFor="pm-db-sql">조회 SQL (선택)</label>
            <textarea
              id="pm-db-sql"
              className="pm-db-sql-textarea"
              placeholder={
                "예) SELECT id, title, body, created_at\n  FROM articles\n WHERE status = 'public'\n ORDER BY created_at DESC"
              }
              value={dbSql}
              onChange={(e) => setDbSql(e.target.value)}
              disabled={submitting}
              rows={6}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <div className="pm-help">
              SELECT 또는 WITH 문만 허용 (DML/DDL 금지). 인덱싱 시 결과
              행을 Markdown 형식으로 변환해 RAG에 포함합니다. 최대{" "}
              <code>50,000행</code>까지 가져오고 그 이상은 잘립니다.
              비워두면 스키마(DDL)만 인덱싱합니다.
            </div>
          </div>

          <div className="pm-db-test-row">
            <button
              type="button"
              className="pm-btn-secondary"
              onClick={runDbSqlPreview}
              disabled={dbSqlPreviewing || submitting || !dbSql.trim()}
            >
              {dbSqlPreviewing ? "조회 중…" : "쿼리 미리보기 (20행)"}
            </button>
            {dbSqlPreview?.error && (
              <div className="pm-db-test-result pm-db-test-err">
                <IconAlertTriangle size={14} />
                <span>{dbSqlPreview.error}</span>
              </div>
            )}
            {dbSqlPreview?.ok && (
              <div className="pm-db-test-result pm-db-test-ok">
                <IconCheckCircle size={14} />
                <span>
                  {dbSqlPreview.row_count}행 미리보기
                  {dbSqlPreview.truncated ? " (cap 도달)" : ""}
                </span>
              </div>
            )}
          </div>

          {dbSqlPreview?.ok && dbSqlPreview.rows.length > 0 && (
            <div className="pm-sql-preview-wrap">
              <table className="pm-sql-preview-table">
                <thead>
                  <tr>
                    {dbSqlPreview.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dbSqlPreview.rows.map((row, i) => (
                    <tr key={i}>
                      {dbSqlPreview.columns.map((c) => {
                        const v = row[c];
                        const shown =
                          v === null || v === undefined
                            ? ""
                            : typeof v === "object"
                            ? JSON.stringify(v)
                            : String(v);
                        return (
                          <td key={c} title={shown}>
                            {shown.length > 80
                              ? shown.slice(0, 80) + "…"
                              : shown}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="pm-field">
          <label htmlFor="pm-source-ref">
            {sourceType === "url" ? "목록 API URL" : sourceMeta.label}
          </label>
          <input
            id="pm-source-ref"
            type={sourceMeta.inputType ?? "text"}
            placeholder={sourceMeta.placeholder}
            value={refs[sourceType]}
            onChange={(e) =>
              setRefs((prev) => ({ ...prev, [sourceType]: e.target.value }))
            }
            disabled={submitting}
          />
          <div className="pm-help">{sourceMeta.help}</div>
        </div>
      )}

      {sourceType === "url" && (
        <div className="pm-api-detail">
          <div className="pm-field">
            <label htmlFor="pm-api-key">상세 키 (태그명, 선택)</label>
            <input
              id="pm-api-key"
              type="text"
              placeholder="예: id  ·  중첩이면 data.id"
              value={apiDetailKey}
              onChange={(e) => setApiDetailKey(e.target.value)}
              disabled={submitting}
              autoComplete="off"
            />
          </div>
          <div className="pm-field">
            <label htmlFor="pm-api-url">상세 API URL 템플릿 (선택)</label>
            <input
              id="pm-api-url"
              type="text"
              placeholder="예: https://api.example.com/items/{key}"
              value={apiDetailUrl}
              onChange={(e) => setApiDetailUrl(e.target.value)}
              disabled={submitting}
              autoComplete="off"
            />
            <div className="pm-help">
              목록 응답(JSON 배열)의 각 항목에서 <code>상세 키</code>를 뽑아
              <code>{"{key}"}</code> 자리에 넣어 상세를 가져옵니다. 두 칸을
              비우면 목록 응답만 인덱싱합니다. 최대{" "}
              <code>{`${5000}`}건</code>.
            </div>
          </div>

          {(apiDetailKey.trim() || apiDetailUrl.trim()) && (
            <div className="pm-db-test-row">
              <button
                type="button"
                className="pm-btn-secondary"
                onClick={runApiPreview}
                disabled={apiPreviewing || submitting}
              >
                {apiPreviewing ? "조회 중…" : "상세 미리보기 (3건)"}
              </button>
              {apiPreview?.error && (
                <div className="pm-db-test-result pm-db-test-err">
                  <IconAlertTriangle size={14} />
                  <span>{apiPreview.error}</span>
                </div>
              )}
              {apiPreview?.ok && (
                <div className="pm-db-test-result pm-db-test-ok">
                  <IconCheckCircle size={14} />
                  <span>
                    목록 {apiPreview.total}건 · {apiPreview.sampled}건
                    상세 수집됨
                  </span>
                </div>
              )}
            </div>
          )}

          {apiPreview?.ok &&
            apiPreview.records &&
            apiPreview.records.length > 0 && (
              <div className="pm-sql-preview-wrap">
                {apiPreview.records.map((rec, i) => (
                  <div key={i} className="pm-api-rec">
                    <div className="pm-api-rec-head">
                      <code>{rec._key}</code>
                      <span className="pm-api-rec-url">{rec._url}</span>
                    </div>
                    <pre className="pm-api-rec-body">
                      {typeof rec._body === "string"
                        ? rec._body.slice(0, 600)
                        : JSON.stringify(rec._body, null, 2).slice(0, 600)}
                    </pre>
                  </div>
                ))}
              </div>
            )}
        </div>
      )}
      {sourceType === "git" && (
        <div className="pm-field">
          <label htmlFor="pm-ref">브랜치 / 태그 (선택)</label>
          <input
            id="pm-ref"
            type="text"
            placeholder="기본 브랜치 사용 (예: main, v1.0)"
            value={gitBranch}
            onChange={(e) => setGitBranch(e.target.value)}
            disabled={submitting}
          />
        </div>
      )}

      {adminMode && (
        <div className="pm-field pm-share-field">
          <label className="pm-share-toggle">
            <input
              type="checkbox"
              checked={isShared}
              onChange={(e) => setIsShared(e.target.checked)}
              disabled={submitting}
            />
            <span>
              <b>공유 지식베이스로 만들기</b>
              <span className="pm-help">
                선택한 역할의 사용자는 채팅에 연결하지 않아도 질문과
                관련될 때 자동으로 이 지식베이스를 검색합니다.
              </span>
            </span>
          </label>

          {isShared && (
            <div className="pm-share-roles">
              <div className="pm-help">이 지식베이스를 사용할 역할</div>
              {roles.length === 0 ? (
                <div className="pm-help">역할 목록을 불러오는 중…</div>
              ) : (
                <div className="pm-share-role-grid">
                  {roles.map((r) => (
                    <label key={r.code} className="pm-share-role-chip">
                      <input
                        type="checkbox"
                        checked={shareRoles.has(r.code)}
                        onChange={(e) =>
                          setShareRoles((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(r.code);
                            else next.delete(r.code);
                            return next;
                          })
                        }
                        disabled={submitting}
                      />
                      <span>{r.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="pm-add-error">
          <IconAlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      <div className="pm-add-actions">
        {onCancel && (
          <button
            type="button"
            className="pm-btn-secondary"
            onClick={onCancel}
            disabled={submitting}
          >
            취소
          </button>
        )}
        <button
          type="button"
          className="pm-btn-primary"
          onClick={submit}
          disabled={submitting}
        >
          {submitting ? (
            "추가 중..."
          ) : (
            <>
              <IconPlus size={14} />
              <span>인덱싱 시작</span>
            </>
          )}
        </button>
      </div>
    </section>
  );
}
