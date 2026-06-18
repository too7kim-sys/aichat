import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { admin, api } from "../api/client";
import { errorToast, infoToast } from "../lib/toast";
import type {
  CorpusType,
  DbDriverInfo,
  DbTestResult,
  Project,
  RagUploadedFile,
  Role,
  SourceType,
  SqlPreviewResult,
} from "../api/client";
import { useProjects } from "../state/ProjectsContext";
import { RolePickerModal } from "./RolePickerModal";
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
    hint: "브라우저에서 직접 업로드, SFTP 서버에서 PDF·DOCX·MD를 받거나 백엔드 서버의 폴더 사용. 단락 단위 검색.",
    sources: ["upload", "sftp", "folder"],
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
      "백엔드 서버의 절대경로. 내부 저장 디렉터리 안의 경로는 등록 불가 — 그쪽은 업로드/SFTP 소스가 자동 관리합니다.",
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
  upload: {
    label: "내 문서 업로드",
    icon: <IconDownload size={14} />,
    placeholder: "",  // unused — uses the file picker UI below
    help:
      "브라우저에서 직접 PDF·DOCX·MD·TXT·HTML 파일을 골라 올립니다. 백엔드에 별도 폴더나 SFTP가 없을 때 사용.",
  },
};

/** Document extensions accepted by the upload source. Mirrors
 *  `_DOCUMENT_EXTS` in backend/app/routers/projects.py — kept in
 *  sync by hand so the picker / drop-zone filters client-side too
 *  (saves a round trip on rejected files). */
/** Server-vulnerable extensions that the backend rejects outright.
 *  Mirrors `_UPLOAD_DENY_EXTS` in backend/app/routers/projects.py —
 *  kept in sync by hand so the picker filters them out client-side
 *  too (no wasted upload on a request the server would 400). */
const _UPLOAD_DENY_EXTENSIONS = new Set([
  // Windows / cross-platform executables + scripts
  ".exe", ".dll", ".bat", ".cmd", ".com", ".scr", ".msi", ".ps1",
  ".vbs", ".vbe", ".jse", ".wsf", ".wsh", ".pif", ".lnk", ".url",
  ".reg", ".sys",
  // Java / native libs
  ".jar", ".war", ".ear", ".class", ".so", ".dylib", ".a",
  // Office files with macros
  ".docm", ".dotm", ".xlsm", ".xltm", ".xlsb",
  ".pptm", ".potm", ".ppsm",
  // Disk images / installers / kernel modules
  ".iso", ".img", ".dmg", ".pkg", ".deb", ".rpm", ".apk", ".ipa",
  ".vhd", ".vmdk", ".ko",
  // HTML applications + Windows installers
  ".hta", ".cpl", ".mst", ".msc",
  // Server scripts
  ".php", ".phtml", ".phar", ".asp", ".aspx", ".cgi",
]);

/** Tally a set of dropped files by extension so the upload form can
 *  show "30개 중 10개 추가됨 — 20개 제외 (.xlsx ×12, .hwp ×8)" instead
 *  of silently keeping a fraction of what the user picked. Returns
 *  an empty string when nothing was rejected. */
function _summarizeRejectedExts(rejected: File[]): string {
  if (rejected.length === 0) return "";
  const buckets: Record<string, number> = {};
  for (const f of rejected) {
    const name = (
      (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
      f.name
    ).toLowerCase();
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot) : "(없음)";
    buckets[ext] = (buckets[ext] ?? 0) + 1;
  }
  const top = Object.entries(buckets)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([ext, n]) => `${ext} ×${n}`);
  const more = Object.keys(buckets).length - top.length;
  return top.join(", ") + (more > 0 ? `, 외 ${more}종` : "");
}

/** Marker glyph + tooltip for one uploaded file's index_status,
 *  shaped like the code workspace tree's ✓ / ⊘ scheme so users get
 *  the same legend in both places. */
function uploadStatusMarker(f: RagUploadedFile): {
  glyph: string;
  cls: string;
  title: string;
} {
  switch (f.index_status) {
    case "indexed":
      return {
        glyph: "✓",
        cls: "ws-mark-ok",
        title: `인덱스 반영됨${f.chunk_count ? ` · ${f.chunk_count} 청크` : ""}`,
      };
    case "pending":
      return {
        glyph: "…",
        cls: "ws-mark-warn",
        title:
          "업로드되었지만 아직 인덱싱되지 않음 — 재인덱싱 버튼을 누르세요.",
      };
    case "oversize":
      return {
        glyph: "⊘",
        cls: "ws-mark-bad",
        title:
          "파일이 RAG_MAX_BYTES_PER_FILE 한도를 초과해 본문이 제외됐습니다.",
      };
    case "unsupported-ext":
      return {
        glyph: "⊘",
        cls: "ws-mark-bad",
        title:
          "이 코퍼스가 지원하지 않는 확장자입니다. 다른 코퍼스로 등록하거나 파일을 변환하세요.",
      };
    case "empty":
      return { glyph: "⊘", cls: "ws-mark-bad", title: "빈 파일" };
    case "no-snapshot":
      return {
        glyph: "·",
        cls: "ws-mark-skip",
        title: "프로젝트가 아직 인덱싱된 적이 없습니다.",
      };
    default:
      return { glyph: "·", cls: "ws-mark-skip", title: f.index_status };
  }
}

/** Top-of-list summary chip — "전부 반영" / "N개 보류 / M개 제외".
 *  Lets the user spot a partial index at a glance without scanning
 *  every row's marker. */
function UploadStatusLegend({ files }: { files: RagUploadedFile[] }) {
  const counts = files.reduce(
    (acc, f) => {
      acc[f.index_status] = (acc[f.index_status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  const ok = counts["indexed"] ?? 0;
  const pending = counts["pending"] ?? 0;
  const skipped =
    (counts["oversize"] ?? 0)
    + (counts["unsupported-ext"] ?? 0)
    + (counts["empty"] ?? 0);
  const noSnap = counts["no-snapshot"] ?? 0;
  const total = files.length;
  const tone =
    noSnap === total
      ? "warn"
      : skipped > 0
      ? "warn"
      : pending > 0
      ? "warn"
      : "ok";
  return (
    <div className={`pm-upload-legend ${tone}`}>
      <span>
        <b>{ok.toLocaleString()}</b>
        <span> / {total.toLocaleString()} 인덱스 반영</span>
      </span>
      {pending > 0 && (
        <span title="업로드는 됐지만 아직 인덱스에 들어가지 않음">
          … 보류 {pending}
        </span>
      )}
      {skipped > 0 && (
        <span title="확장자·크기 등의 사유로 인덱스에서 제외됨">
          ⊘ 제외 {skipped}
        </span>
      )}
      {noSnap > 0 && (
        <span title="프로젝트가 아직 인덱싱된 적이 없습니다">
          · 인덱싱 필요 {noSnap}
        </span>
      )}
    </div>
  );
}

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
  const { projects, create, remove, reindex, refresh } = useProjects();
  // Sub-popup state — what the row-action / "+ 추가" buttons open as
  // an overlay on top of the list table. `"new"` opens the add form,
  // a project id opens that project's detail card. Splitting the
  // list view from the detail view keeps the list usable when the
  // catalog grows past a handful of rows (the old master-detail
  // sidebar got cramped at 260px once we had 10+ projects).
  const [subPopup, setSubPopup] = useState<string | "new" | null>(null);
  const subDetailProject = subPopup && subPopup !== "new"
    ? projects.find((p) => p.id === subPopup) ?? null
    : null;
  // Free-text search across the row table. Empty == show all.
  const [query, setQuery] = useState("");
  // Role catalog for the admin share-grant UI. Only fetched in admin
  // mode; non-admins can't hit /admin/roles anyway.
  const [roles, setRoles] = useState<Role[]>([]);
  useEffect(() => {
    if (open && adminMode) {
      admin.listRoles().then(setRoles).catch(() => undefined);
    }
  }, [open, adminMode]);

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

  // Drive the sub-popup from the parent-supplied initial flags so
  // AdminPage's "관리" / "RAG 추가" buttons keep jumping straight to
  // the detail / add form instead of showing the list table first.
  useEffect(() => {
    if (!open) return;
    if (initialAddOpen) {
      setSubPopup("new");
    } else if (initialProjectId) {
      setSubPopup(initialProjectId);
    } else if (projects.length === 0) {
      // Empty-list onboarding — open the add form directly.
      setSubPopup("new");
    }
  }, [open, initialAddOpen, initialProjectId, projects.length]);

  if (!open) return null;

  // Filter rows by the toolbar's search query — matches the
  // project's display name + the masked source ref + the corpus
  // label so a user searching "그룹웨어" or "sftp" can find rows
  // quickly even when the catalog has dozens of entries.
  const q = query.trim().toLowerCase();
  const filteredProjects = q
    ? projects.filter((p) => {
        const meta = CORPUS_META[p.corpus_type] ?? CORPUS_META.document;
        return (
          p.name.toLowerCase().includes(q) ||
          maskSourceRef(p.source_type, p.source_ref)
            .toLowerCase()
            .includes(q) ||
          meta.label.toLowerCase().includes(q) ||
          p.source_type.toLowerCase().includes(q)
        );
      })
    : projects;

  // List-only body — full-width table of projects with a search +
  // "+ RAG 추가" toolbar. Selecting a row opens a separate
  // overlay popup with that project's detail card; the add form
  // gets its own overlay too. Splitting list from detail keeps the
  // table readable when the catalog grows past a handful of rows.
  const body = (
    <div className="pm-body pm-body-table">
      <div className="pm-list-toolbar">
        <div className="pm-list-search">
          <input
            type="text"
            placeholder="이름 · 출처 · 코퍼스로 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="pm-list-search-clear"
              onClick={() => setQuery("")}
              aria-label="검색 지우기"
            >
              <IconX size={12} />
            </button>
          )}
        </div>
        <button
          type="button"
          className="pm-btn-primary pm-list-add"
          onClick={() => setSubPopup("new")}
        >
          <IconPlus size={14} />
          <span>새 RAG 추가</span>
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="pm-empty">
          <IconBookOpen size={28} />
          <p>아직 추가된 프로젝트가 없습니다.</p>
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="pm-empty">
          <p>검색 결과가 없습니다.</p>
        </div>
      ) : (
        <div className="pm-list-scroll">
          <table className="pm-list-table">
            <thead>
              <tr>
                <th>이름</th>
                <th>코퍼스</th>
                <th>소스</th>
                <th>상태</th>
                <th>스냅샷</th>
                {adminMode && <th>공유</th>}
                <th className="pm-list-actions-col">작업</th>
              </tr>
            </thead>
            <tbody>
              {filteredProjects.map((p) => (
                <ProjectListRow
                  key={p.id}
                  project={p}
                  linked={linkedProjectId === p.id}
                  adminMode={adminMode}
                  onOpen={() => setSubPopup(p.id)}
                  onDelete={
                    p.owned || adminMode
                      ? async () => {
                          if (
                            !window.confirm(
                              `"${p.name}"을(를) 삭제할까요?\n인덱스도 함께 사라지고 디스크 공간이 회수됩니다.`,
                            )
                          )
                            return;
                          if (linkedProjectId === p.id)
                            onLinkChange?.(null);
                          try {
                            const { freedBytes } = await remove(p.id);
                            if (freedBytes > 0) {
                              console.info(
                                `[RAG] "${p.name}" 삭제 — ${fmtBytes(freedBytes)} 회수`,
                              );
                            }
                          } catch (e) {
                            errorToast("삭제 실패", e);
                          }
                        }
                      : null
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  // Sub-popup overlay rendered ON TOP of the list table. Shares the
  // same close-on-backdrop / ESC contract as the parent. Either the
  // add form or the project card lives inside; the parent list
  // updates as soon as the sub-popup closes (useProjects refresh).
  const subPopupOverlay = subPopup === null ? null : (
    <div
      className="modal-backdrop pm-sub-backdrop"
      onClick={() => setSubPopup(null)}
    >
      <div
        className="modal pm-sub-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="pm-head">
          <div className="pm-head-text">
            <h3>
              {subPopup === "new"
                ? "새 RAG 프로젝트 추가"
                : subDetailProject?.name ?? "프로젝트"}
            </h3>
          </div>
          <div className="pm-head-right">
            <button
              type="button"
              className="modal-close"
              onClick={() => setSubPopup(null)}
              aria-label="닫기"
            >
              <IconX size={18} />
            </button>
          </div>
        </header>
        <div className="pm-sub-body">
          {subPopup === "new" ? (
            <AddProjectForm
              compact={projects.length > 0}
              adminMode={adminMode}
              roles={roles}
              onCancel={() => setSubPopup(null)}
              onSubmit={async (payload) => {
                const created = await create(payload);
                setSubPopup(null);
                return created;
              }}
            />
          ) : subDetailProject ? (
            <ProjectCard
              project={subDetailProject}
              adminMode={adminMode}
              allRoles={roles}
              initialSnapshotsOpen={initialSnapshotsOpen}
              linkable={!!linkSessionId}
              linked={linkedProjectId === subDetailProject.id}
              onLink={() => {
                onLinkChange?.(
                  linkedProjectId === subDetailProject.id
                    ? null
                    : subDetailProject.id,
                );
              }}
              onReindex={() => reindex(subDetailProject.id)}
              onDelete={async () => {
                if (
                  !window.confirm(
                    `"${subDetailProject.name}"을(를) 삭제할까요?\n인덱스도 함께 사라지고 디스크 공간이 회수됩니다.`,
                  )
                )
                  return;
                if (linkedProjectId === subDetailProject.id)
                  onLinkChange?.(null);
                try {
                  const { freedBytes } = await remove(subDetailProject.id);
                  if (freedBytes > 0) {
                    console.info(
                      `[RAG] "${subDetailProject.name}" 삭제 — ${fmtBytes(freedBytes)} 회수`,
                    );
                  }
                  setSubPopup(null);
                } catch (e) {
                  errorToast("삭제 실패", e);
                }
              }}
            />
          ) : (
            <div className="pm-detail-empty">
              프로젝트를 찾을 수 없습니다.
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div className="pm-embedded">
        {body}
        {subPopupOverlay}
      </div>
    );
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onClose}>
        <div
          className="modal projects-modal projects-modal-list"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="pm-head">
            <div className="pm-head-text">
              <h3>RAG 프로젝트</h3>
              <p>지식베이스를 등록·관리하세요. 클릭하면 상세 화면이 열립니다.</p>
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
      {subPopupOverlay}
    </>
  );
}

// ── Project table row ────────────────────────────────────────────────

function ProjectListRow({
  project: p,
  linked,
  adminMode,
  onOpen,
  onDelete,
}: {
  project: Project;
  linked: boolean;
  adminMode: boolean;
  onOpen: () => void;
  onDelete: (() => void | Promise<void>) | null;
}) {
  const meta = CORPUS_META[p.corpus_type] ?? CORPUS_META.document;
  const statusText =
    p.status === "ready"
      ? "준비됨"
      : p.status === "indexing"
      ? p.progress_total
        ? `인덱싱 ${Math.round((100 * p.progress_done) / p.progress_total)}%`
        : "인덱싱"
      : p.status === "failed"
      ? "실패"
      : "대기";
  return (
    <tr className={`pm-list-row${linked ? " linked" : ""}`}>
      <td className="pm-list-name" onClick={onOpen}>
        <span className="pm-list-name-icon" aria-hidden>
          {SOURCE_META[p.source_type]?.icon ?? <IconFolder size={13} />}
        </span>
        <span className="pm-list-name-text" title={p.name}>
          {p.name}
        </span>
        {linked && (
          <span
            className="pm-list-linked"
            title="현재 채팅에 연결됨"
          >
            <IconCheck size={11} />
          </span>
        )}
      </td>
      <td onClick={onOpen}>
        <span className={`pm-list-corpus corpus-${p.corpus_type}`}>
          {meta.label}
        </span>
      </td>
      <td className="pm-list-source-cell" onClick={onOpen}>
        <code>{p.source_type}</code>
      </td>
      <td onClick={onOpen}>
        <span className={`pm-list-status status-${p.status}`}>{statusText}</span>
      </td>
      <td onClick={onOpen} className="pm-list-num">
        {p.snapshots?.length ?? 0}
      </td>
      {adminMode && (
        <td onClick={onOpen}>
          {p.is_shared ? (
            <span className="pm-list-shared">
              {p.role_codes.length > 0
                ? `${p.role_codes.length}개 역할`
                : "공유"}
            </span>
          ) : (
            <span className="pm-cell-muted">개인</span>
          )}
        </td>
      )}
      <td className="pm-list-actions-col">
        <div className="pm-list-actions">
          <button
            type="button"
            className="pm-btn-secondary"
            onClick={onOpen}
          >
            관리
          </button>
          {onDelete && (
            <button
              type="button"
              className="pm-btn-secondary pm-list-danger"
              onClick={onDelete}
              title="삭제"
            >
              <IconTrash size={13} />
            </button>
          )}
        </div>
      </td>
    </tr>
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
  // Lazy-expand the snapshot list — under a busy schedule a project
  // can accumulate hundreds of rows that'd push everything else off
  // the screen. Show the most recent N first, then "더 보기" to
  // reveal the rest. Reset to collapsed whenever the project changes
  // so a switch to a different card always opens fresh.
  const SNAPSHOT_PREVIEW = 5;
  const [snapshotsExpanded, setSnapshotsExpanded] = useState(false);
  useEffect(() => {
    setSnapshotsExpanded(false);
  }, [p.id]);
  // Edit mode — populated from the current project when the user
  // clicks 편집. Save = PATCH, then refresh; cancel reverts.
  const [editing, setEditing] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  // Role picker popup — opened by the "역할 선택" button in the share
  // section. Selecting through a modal keeps the panel usable when
  // the role catalog grows past a flat checkbox grid (~10 entries).
  const [editRolesPickerOpen, setEditRolesPickerOpen] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [eName, setEName] = useState(p.name);
  const [eSourceRef, setESourceRef] = useState(p.source_ref);
  const [eSql, setESql] = useState(p.sql_query ?? "");
  const [eApiKey, setEApiKey] = useState(p.api_detail_key ?? "");
  const [eApiUrl, setEApiUrl] = useState(p.api_detail_url ?? "");
  const [eShared, setEShared] = useState(p.is_shared);
  const [eRoles, setERoles] = useState<Set<string>>(new Set(p.role_codes));
  const [eTeamId, setETeamId] = useState<string>(p.team_id ?? "");
  const [eTeams, setETeams] = useState<{ id: string; name: string }[]>([]);
  const [eRetention, setERetention] = useState<string>(
    String(p.snapshot_retention_count ?? 10),
  );

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
    setETeamId(p.team_id ?? "");
    setERetention(String(p.snapshot_retention_count ?? 10));
  }, [
    p.id, p.name, p.source_ref, p.sql_query, p.api_detail_key,
    p.api_detail_url, p.is_shared, p.role_codes, p.team_id,
    p.snapshot_retention_count, editing,
  ]);

  useEffect(() => {
    api
      .listTeams()
      .then((r) => setETeams(r.map((t) => ({ id: t.id, name: t.name }))))
      .catch(() => setETeams([]));
  }, []);

  async function saveEdit() {
    setEditBusy(true);
    setEditErr(null);
    try {
      const payload: Parameters<typeof update>[1] = {};
      if (eName.trim() !== p.name) payload.name = eName.trim();
      // Upload source's source_ref is a backend-managed directory path —
      // changing it would orphan the uploaded files. Skip the field for
      // upload projects (the edit form hides the input for the same
      // reason).
      if (
        p.source_type !== "upload"
        && eSourceRef.trim() !== p.source_ref
      ) {
        payload.source_ref = eSourceRef.trim();
      }
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
      if ((eTeamId || null) !== (p.team_id ?? null)) {
        payload.team_id = eTeamId || null;
      }
      // Retention — parse to a sane integer in [0, 10000]. 0 reads
      // as "무제한" in the form; the backend uses the same convention.
      const parsedRetention = Math.max(
        0, Math.min(10000, Math.floor(Number(eRetention) || 0)),
      );
      if (parsedRetention !== (p.snapshot_retention_count ?? 10)) {
        payload.snapshot_retention_count = parsedRetention;
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
              {p.snapshot_retention_count > 0 && (
                <span className="pm-snap-current-label">
                  &nbsp;· 보관 {p.snapshot_retention_count}개
                </span>
              )}
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
                .slice(
                  0,
                  snapshotsExpanded ? totalSnapshots : SNAPSHOT_PREVIEW,
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
                        {!isCurrent && s.status === "ready" &&
                          (p.owned || adminMode) && (
                          <button
                            type="button"
                            className="pm-snap-btn"
                            onClick={() => activateSnapshot(p.id, s.id)}
                            title="이 스냅샷을 현재로 설정"
                          >
                            현재로
                          </button>
                        )}
                        {totalSnapshots > 1 && (p.owned || adminMode) && (
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
                                  (err) => errorToast("삭제 실패", err),
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
          {snapshotsOpen && totalSnapshots > SNAPSHOT_PREVIEW && (
            <button
              type="button"
              className="pm-snap-more"
              onClick={() => setSnapshotsExpanded((v) => !v)}
            >
              {snapshotsExpanded
                ? "접기"
                : `더 보기 (${totalSnapshots - SNAPSHOT_PREVIEW}개 더)`}
            </button>
          )}
        </div>
      )}

      {p.source_type === "upload" && (
        <UploadFilesPanel
          projectId={p.id}
          hasSnapshot={p.current_snapshot_id != null}
          readOnly={!p.owned && !adminMode}
          onAfterChange={async () => {
            // First-time upload (no snapshot yet) → full reindex
            // creates the inaugural snapshot. Subsequent edits use
            // incremental refresh to keep the existing index in sync
            // without piling up snapshots.
            if (p.current_snapshot_id == null) {
              await onReindex();
            } else {
              await refreshProject(p.id);
            }
          }}
        />
      )}

      {p.status === "ready" && (p.owned || adminMode) && (
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
        {p.owned || adminMode ? (
          <button
            type="button"
            className="pm-icon-btn danger"
            onClick={onDelete}
            title={
              p.owned
                ? "삭제"
                : "공유 지식베이스 삭제 (관리자) — 서버 파일도 함께 제거"
            }
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
          {p.source_type !== "upload" && (
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
          )}

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
                  <RoleSummaryRow
                    roles={allRoles}
                    selected={eRoles}
                    onOpenPicker={() => setEditRolesPickerOpen(true)}
                  />
                </div>
              )}
            </div>
          )}

          <div className="pm-field">
            <label htmlFor={`pm-edit-team-${p.id}`}>공유 팀 (선택)</label>
            <select
              id={`pm-edit-team-${p.id}`}
              value={eTeamId}
              onChange={(e) => setETeamId(e.target.value)}
              disabled={editBusy}
            >
              <option value="">— 개인 지식베이스 —</option>
              {eTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <div className="pm-help">
              팀을 지정하면 팀원이 검색·채팅에서 함께 활용할 수 있습니다.
            </div>
          </div>

          <div className="pm-field">
            <label htmlFor={`pm-edit-retention-${p.id}`}>
              스냅샷 보관 개수
            </label>
            <div className="pm-retention-row">
              <input
                id={`pm-edit-retention-${p.id}`}
                type="number"
                min={0}
                max={10000}
                step={1}
                value={eRetention}
                onChange={(e) => setERetention(e.target.value)}
                disabled={editBusy}
                className="pm-retention-input"
              />
              <span className="pm-help" style={{ margin: 0 }}>
                {Number(eRetention) === 0
                  ? "무제한 — 모든 스냅샷을 보관 (디스크 사용 주의)"
                  : `최근 ${Number(eRetention) || 0}개만 유지, 그 이상은 자동 삭제`}
              </span>
            </div>
            <div className="pm-help">
              새 스냅샷이 생성될 때마다 오래된 것부터 정리됩니다. 현재 활성
              스냅샷은 보관 개수와 무관하게 항상 유지됩니다.
            </div>
          </div>

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

      {editRolesPickerOpen && (
        <RolePickerModal
          roles={allRoles}
          initial={Array.from(eRoles)}
          multiple
          title="역할 선택"
          description="이 지식베이스에 접근할 수 있는 역할을 선택하세요. 선택된 역할의 사용자는 채팅에서 자동으로 검색에 활용됩니다."
          onClose={() => setEditRolesPickerOpen(false)}
          onSave={(codes) => {
            setERoles(new Set(codes));
            setEditRolesPickerOpen(false);
          }}
        />
      )}
    </article>
  );
}

/** Inline summary chip row for a set of selected role codes plus
 *  an "역할 선택" button that opens the full picker. Keeps the share
 *  section compact when only a few roles are mapped, while the
 *  popup handles the long-list case. */
function RoleSummaryRow({
  roles,
  selected,
  onOpenPicker,
}: {
  roles: Role[];
  selected: Set<string>;
  onOpenPicker: () => void;
}) {
  const codeToName = new Map(roles.map((r) => [r.code, r.name]));
  const codes = Array.from(selected);
  return (
    <div className="pm-share-summary">
      <button
        type="button"
        className="pm-btn-secondary"
        onClick={onOpenPicker}
      >
        역할 선택 ({codes.length})
      </button>
      <div className="role-chip-stack">
        {codes.length === 0 ? (
          <span className="pm-help" style={{ margin: 0 }}>
            아직 선택된 역할이 없습니다.
          </span>
        ) : (
          codes.map((c) => (
            <span key={c} className="role-chip">
              {codeToName.get(c) ?? c}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

// ── Upload-source file management ────────────────────────────────────

function UploadFilesPanel({
  projectId,
  hasSnapshot,
  readOnly = false,
  onAfterChange,
}: {
  projectId: string;
  /** Whether the project already has at least one snapshot — controls
   *  the "변경됨" indicator copy ("새 인덱싱" vs "다시 인덱싱"). */
  hasSnapshot: boolean;
  /** When true, the panel renders the listing without add / delete
   *  affordances — used for shared knowledge bases where the viewer
   *  has read access but isn't the owner. Download is always
   *  available (it's the same content the chat would already cite). */
  readOnly?: boolean;
  /** Called after a successful add/remove so the parent can trigger
   *  the appropriate indexing path (full reindex for first time, then
   *  incremental for subsequent edits). Ignored in readOnly mode. */
  onAfterChange?: () => Promise<void> | void;
}) {
  const [files, setFiles] = useState<RagUploadedFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pickRef = useRef<HTMLInputElement | null>(null);
  const folderPickRef = useRef<HTMLInputElement | null>(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      setFiles(await api.listProjectUploads(projectId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function addFiles(picked: File[], fromFolder: boolean) {
    if (picked.length === 0) return;
    // Drop anything not in the document allow-list before hitting the
    // network — block only the server-vulnerable formats (exe/dll/
    // macros/disk images) and let everything else through. The
    // indexer still decides what text-extracts; non-extractable
    // files stay downloadable from the manage panel.
    const filtered = picked.filter((f) => {
      const name = (
        (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
        f.name
      ).toLowerCase();
      const dot = name.lastIndexOf(".");
      const ext = dot >= 0 ? name.slice(dot) : "";
      return !_UPLOAD_DENY_EXTENSIONS.has(ext);
    });
    const rejected = picked.filter((f) => !filtered.includes(f));
    if (filtered.length === 0) {
      setErr(
        fromFolder
          ? `폴더에서 가져올 수 있는 파일이 없습니다 — 차단된 확장자 ${rejected.length}개 (${_summarizeRejectedExts(rejected)})`
          : `서버 보안 정책상 차단된 확장자입니다 (${_summarizeRejectedExts(rejected)})`,
      );
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const result = await api.uploadProjectFiles(projectId, filtered);
      setFiles(result.files);
      // Build a single notice covering both client-side rejections
      // (extension deny-list) and per-file server-side errors (magic
      // sniff / size cap / write fail) so the user sees every file
      // that didn't land instead of just the first one.
      const notices: string[] = [];
      if (rejected.length > 0) {
        notices.push(
          `차단된 확장자 ${rejected.length}개 (${_summarizeRejectedExts(rejected)})`,
        );
      }
      if (result.errors.length > 0) {
        const sample = result.errors
          .slice(0, 3)
          .map((e) => `${e.filename}: ${e.reason}`)
          .join(" / ");
        const more =
          result.errors.length > 3
            ? ` (외 ${result.errors.length - 3}개)`
            : "";
        notices.push(`서버 거부 ${result.errors.length}개 — ${sample}${more}`);
      }
      if (notices.length > 0) {
        setErr(
          `${picked.length}개 중 ${result.files.length}개 추가됨 — ${notices.join(" · ")}`,
        );
      }
      await onAfterChange?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeFile(name: string) {
    if (!window.confirm(`"${name}"을(를) 삭제할까요?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteProjectUpload(projectId, name);
      setFiles((prev) => prev?.filter((f) => f.filename !== name) ?? null);
      await onAfterChange?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function downloadFile(name: string) {
    setErr(null);
    try {
      await api.downloadProjectUpload(projectId, name);
    } catch (e) {
      setErr(
        `다운로드 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return (
    <div className="pm-upload-panel">
      <div className="pm-upload-panel-head">
        <span className="pm-upload-panel-title">
          <IconDownload size={13} />{" "}
          {readOnly ? "사내 문서" : "업로드된 문서"}{" "}
          {files != null && `(${files.length})`}
        </span>
        {!readOnly && (
          <>
            <button
              type="button"
              className="pm-btn-secondary pm-upload-panel-add"
              onClick={() => pickRef.current?.click()}
              disabled={busy}
            >
              <IconPlus size={13} /> 파일 추가
            </button>
            <button
              type="button"
              className="pm-btn-secondary pm-upload-panel-add"
              onClick={() => folderPickRef.current?.click()}
              disabled={busy}
              title="폴더를 통째로 추가 (하위 폴더 구조 유지)"
            >
              <IconFolder size={13} /> 폴더 추가
            </button>
            <input
              ref={pickRef}
              type="file"
              multiple
             
              style={{ display: "none" }}
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                e.target.value = "";
                addFiles(picked, false);
              }}
            />
            <input
              ref={folderPickRef}
              type="file"
              multiple
              style={{ display: "none" }}
              {...{ webkitdirectory: "", directory: "" }}
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                e.target.value = "";
                addFiles(picked, true);
              }}
            />
          </>
        )}
      </div>
      {err && (
        <div className="pm-add-error">
          <IconAlertTriangle size={13} />
          <span>{err}</span>
        </div>
      )}
      {loading && files == null ? (
        <div className="pm-help">불러오는 중…</div>
      ) : files && files.length > 0 ? (
        <>
          <UploadStatusLegend files={files} />
          <ul className="pm-upload-list">
            {files.map((f) => {
              const mark = uploadStatusMarker(f);
              return (
                <li key={f.filename} className="pm-upload-item">
                  <span
                    className={`pm-upload-status ${mark.cls}`}
                    title={mark.title}
                    aria-label={mark.title}
                  >
                    {mark.glyph}
                  </span>
                  <span className="pm-upload-item-name" title={f.filename}>
                    {f.filename}
                  </span>
                  {f.chunk_count != null && f.chunk_count > 0 && (
                    <span className="pm-upload-item-chunks">
                      {f.chunk_count.toLocaleString()} 청크
                    </span>
                  )}
                  <span className="pm-upload-item-size">{fmtBytes(f.size)}</span>
                  <button
                    type="button"
                    className="pm-upload-item-download"
                    onClick={() => downloadFile(f.filename)}
                    aria-label="다운로드"
                    title="다운로드"
                  >
                    <IconDownload size={12} />
                  </button>
                  {!readOnly && (
                    <button
                      type="button"
                      className="pm-upload-item-remove"
                      onClick={() => removeFile(f.filename)}
                      disabled={busy}
                      aria-label="삭제"
                      title="삭제"
                    >
                      <IconX size={12} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <div className="pm-help">
          {readOnly
            ? "공유된 문서가 없습니다."
            : `업로드된 문서가 없습니다. "파일 추가"로 PDF·DOCX·MD 등을 올리면${
                hasSnapshot ? " 증분 인덱싱" : " 인덱싱"
              }이 자동으로 시작됩니다.`}
        </div>
      )}
    </div>
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
  /** Returns the created project so callers (the upload-source path)
   *  can stage files against the new project's id before triggering
   *  the first index. Non-upload sources don't use the return value. */
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
  }) => Promise<Project | void>;
}) {
  // Shared knowledge-base toggle + role grants (admin only). Default
  // ON in admin mode — knowledge bases created from the admin panel
  // are shared by intent; the operator unchecks for a private one.
  const [isShared, setIsShared] = useState(adminMode);
  const [shareRoles, setShareRoles] = useState<Set<string>>(new Set());
  const [addRolesPickerOpen, setAddRolesPickerOpen] = useState(false);
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
    upload: "",  // unused — upload uses the file picker below
  });
  // 내 문서 업로드 — files picked in the browser, staged in state, then
  // POSTed to the new project's upload endpoint after the project is
  // created. We hold the File objects (not extracted text) so the
  // backend gets the original bytes for indexing. Two input refs so
  // the user can pick individual files OR a whole folder (webkitdir),
  // and the folder structure is preserved via webkitRelativePath.
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const uploadFolderRef = useRef<HTMLInputElement | null>(null);

  /** Stage a batch of picked files (file picker or folder picker),
   *  filtering by the document extension allow-list and de-duping
   *  against what's already queued. Both file + folder picks now
   *  surface the per-extension skip count so the user can tell at
   *  a glance which formats need converting (xlsx → csv, hwp → pdf)
   *  before pressing 추가. */
  function addStagedUploads(picked: File[], fromFolder: boolean) {
    if (picked.length === 0) return;
    const filtered = picked.filter((f) => {
      const name = (
        (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
        f.name
      ).toLowerCase();
      // Files without an extension (Dockerfile / Makefile / LICENSE /
      // README) are allowed — they're text artefacts the indexer can
      // decode just fine. Only the deny-list blocks anything.
      const dot = name.lastIndexOf(".");
      const ext = dot >= 0 ? name.slice(dot) : "";
      return !_UPLOAD_DENY_EXTENSIONS.has(ext);
    });
    const rejected = picked.filter((f) => !filtered.includes(f));
    if (filtered.length === 0) {
      setError(
        fromFolder
          ? `폴더에서 가져올 수 있는 파일이 없습니다 — 차단된 확장자 ${rejected.length}개 (${_summarizeRejectedExts(rejected)})`
          : `서버 보안 정책상 차단된 확장자입니다 (${_summarizeRejectedExts(rejected)})`,
      );
      return;
    }
    if (rejected.length > 0) {
      // Partial pick — non-fatal: keep what we got, but tell the
      // user which security-blocked extensions got dropped.
      setError(
        `${picked.length}개 중 ${filtered.length}개 추가됨 — ${rejected.length}개 차단된 확장자 제외 (${_summarizeRejectedExts(rejected)})`,
      );
    } else {
      // Clear any earlier "차단" notice once a clean pick lands.
      setError(null);
    }
    setUploadFiles((prev) => {
      const seen = new Set(
        prev.map((f) => {
          const r =
            (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
            f.name;
          return `${r}::${f.size}`;
        }),
      );
      const next = [...prev];
      for (const f of filtered) {
        const r =
          (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
          f.name;
        if (!seen.has(`${r}::${f.size}`)) {
          next.push(f);
          seen.add(`${r}::${f.size}`);
        }
      }
      return next;
    });
  }
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
  // 서버 폴더(folder) 와 DB 코퍼스(connection) 는 관리자 전용으로 제한.
  // 일반 사용자가 서버 절대경로를 직접 적거나 사내 DB 에 임의 접속하는
  // 시도를 막는다.
  const visibleSources = (arr: SourceType[]) =>
    adminMode ? arr : arr.filter((s) => s !== "folder");
  const visibleCorpusTabs = (["document", "api", "db"] as const).filter(
    (t) => adminMode || t !== "db",
  );

  function onCorpusChange(t: CorpusType) {
    setCorpusType(t);
    const allowed = visibleSources(CORPUS_META[t].sources);
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
    } else if (sourceType === "upload") {
      if (uploadFiles.length === 0) {
        setError("업로드할 문서를 1개 이상 선택하세요");
        return;
      }
      // The backend rewrites source_ref to the per-project upload
      // directory; any value here is just a placeholder for the
      // create payload (which requires source_ref >= 1 char).
      sourceRef = "uploads";
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
      const created = await onSubmit({
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
      // Upload source: the create endpoint left status='pending' with
      // no snapshot. Push the staged files into the project's upload
      // dir, then trigger the first index. Failures here surface as
      // form errors so the user knows the project exists but the
      // files didn't make it.
      if (sourceType === "upload" && created && uploadFiles.length > 0) {
        try {
          const result = await api.uploadProjectFiles(
            created.id,
            uploadFiles,
          );
          if (result.errors.length > 0) {
            // Surface per-file rejections even when the batch
            // overall succeeded — the user just made the project,
            // they need to know which docs to fix/convert before
            // re-uploading.
            const sample = result.errors
              .slice(0, 3)
              .map((e) => `${e.filename}: ${e.reason}`)
              .join(" / ");
            const more =
              result.errors.length > 3
                ? ` (외 ${result.errors.length - 3}개)`
                : "";
            infoToast(
              `${uploadFiles.length}개 중 ${result.files.length}개 업로드됨 — ` +
                `${result.errors.length}개 거부: ${sample}${more}`,
            );
          }
          await api.reindexProject(created.id);
        } catch (uploadErr) {
          setError(
            `파일 업로드 실패: ${
              uploadErr instanceof Error
                ? uploadErr.message
                : String(uploadErr)
            }`,
          );
          return;
        }
      }
      setName("");
      setRefs({
        git: "", folder: "", url: "", connection: "", sftp: "", upload: "",
      });
      setUploadFiles([]);
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
          {visibleCorpusTabs.map((t) => {
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
          {visibleSources(corpusMeta.sources).map((st) => {
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

      {sourceType === "upload" ? (
        <div className="pm-field">
          <label htmlFor="pm-upload-input">업로드할 문서</label>
          <div className="pm-upload-pick-row">
            <button
              type="button"
              className="pm-btn-secondary"
              onClick={() => uploadInputRef.current?.click()}
              disabled={submitting}
            >
              <IconPlus size={14} /> 파일 선택
            </button>
            <button
              type="button"
              className="pm-btn-secondary"
              onClick={() => uploadFolderRef.current?.click()}
              disabled={submitting}
              title="폴더를 통째로 선택 (하위 폴더 구조 유지)"
            >
              <IconFolder size={14} /> 폴더 선택
            </button>
            <span className="pm-help" style={{ margin: 0 }}>
              {uploadFiles.length > 0
                ? `${uploadFiles.length}개 선택됨 (${fmtBytes(
                    uploadFiles.reduce((s, f) => s + f.size, 0),
                  )})`
                : "PDF · DOCX · MD · TXT · CSV · 그 외 모든 문서 (실행 파일·매크로 제외)"}
            </span>
          </div>
          <input
            ref={uploadInputRef}
            id="pm-upload-input"
            type="file"
            multiple
           
            style={{ display: "none" }}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              addStagedUploads(picked, false);
              e.target.value = "";
            }}
          />
          {/* Folder picker — webkitdirectory is non-standard so React's
            * typings don't know about it. The HTML attribute survives
            * because we spread the property; browsers that don't
            * support it fall back to a normal file input. */}
          <input
            ref={uploadFolderRef}
            type="file"
            multiple
            style={{ display: "none" }}
            {...{ webkitdirectory: "", directory: "" }}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              addStagedUploads(picked, true);
              e.target.value = "";
            }}
          />
          {uploadFiles.length > 0 && (
            <ul className="pm-upload-list">
              {uploadFiles.map((f, i) => {
                const rel =
                  (f as File & { webkitRelativePath?: string })
                    .webkitRelativePath || f.name;
                return (
                  <li key={`${rel}-${i}`} className="pm-upload-item">
                    <span className="pm-upload-item-name" title={rel}>
                      {rel}
                    </span>
                    <span className="pm-upload-item-size">
                      {fmtBytes(f.size)}
                    </span>
                    <button
                      type="button"
                      className="pm-upload-item-remove"
                      onClick={() =>
                        setUploadFiles((prev) =>
                          prev.filter((_, idx) => idx !== i),
                        )
                      }
                      disabled={submitting}
                      aria-label="제거"
                      title="제거"
                    >
                      <IconX size={12} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="pm-help">
            파일 또는 폴더를 골라 올릴 수 있고, 폴더는 하위 구조를 그대로
            유지합니다. 실행 파일(.exe / .dll / .bat …) · 매크로 포함 문서
            (.docm / .xlsm …) · 디스크 이미지(.iso / .dmg …) 등 서버 보안 정책상
            위험한 형식만 차단됩니다. 그 외 모든 문서는 업로드되며,
            인덱서가 자동으로 텍스트를 추출할 수 있는 형식만 검색에 반영합니다
            (나머지는 다운로드만 가능).
          </div>
        </div>
      ) : sourceType === "sftp" ? (
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
                <RoleSummaryRow
                  roles={roles}
                  selected={shareRoles}
                  onOpenPicker={() => setAddRolesPickerOpen(true)}
                />
              )}
            </div>
          )}
        </div>
      )}

      {addRolesPickerOpen && (
        <RolePickerModal
          roles={roles}
          initial={Array.from(shareRoles)}
          multiple
          title="역할 선택"
          description="이 지식베이스에 접근할 수 있는 역할을 선택하세요. 선택된 역할의 사용자는 채팅에서 자동으로 검색에 활용됩니다."
          onClose={() => setAddRolesPickerOpen(false)}
          onSave={(codes) => {
            setShareRoles(new Set(codes));
            setAddRolesPickerOpen(false);
          }}
        />
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
            "추가 중…"
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
