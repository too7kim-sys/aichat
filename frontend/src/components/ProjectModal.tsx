import { useEffect, useState } from "react";
import type { CorpusType, Project } from "../api/client";
import { useProjects } from "../state/ProjectsContext";

const CORPUS_META: Record<
  CorpusType,
  { label: string; icon: string; hint: string }
> = {
  code: {
    label: "코드",
    icon: "💻",
    hint: "소스 트리(.py / .ts / .java / …). 함수 단위 검색에 강함.",
  },
  document: {
    label: "문서",
    icon: "📄",
    hint: "매뉴얼·기획서·백서 (.pdf / .docx / .md / .txt). 단락 단위 검색.",
  },
  legal: {
    label: "법령",
    icon: "⚖",
    hint: "법령·약관 (.pdf / .docx / .txt). 제N조 단위로 자동 분할.",
  },
  api: {
    label: "API",
    icon: "🔌",
    hint: "OpenAPI / Swagger (.json / .yaml). 엔드포인트 단위로 분할.",
  },
};

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
}: Props) {
  const { projects, storageBytes, create, remove, reindex, refresh } =
    useProjects();
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    refresh();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, refresh]);

  // Auto-open the add form when the list is empty so the empty state
  // doubles as the onboarding CTA.
  useEffect(() => {
    if (open && projects.length === 0) setAddOpen(true);
  }, [open, projects.length]);

  if (!open) return null;

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
            {storageBytes > 0 && (
              <div className="pm-storage" title="벡터 인덱스가 차지하는 디스크 용량">
                💾 {fmtBytes(storageBytes)}
              </div>
            )}
            <button
              type="button"
              className="modal-close"
              onClick={onClose}
              aria-label="닫기"
            >
              ×
            </button>
          </div>
        </header>

        <div className="pm-body">
          {projects.length > 0 && (
            <div className="pm-list">
              {projects.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  linkable={!!linkSessionId}
                  linked={linkedProjectId === p.id}
                  onLink={() =>
                    onLinkChange?.(linkedProjectId === p.id ? null : p.id)
                  }
                  onReindex={() => reindex(p.id)}
                  onDelete={async () => {
                    if (
                      !window.confirm(
                        `"${p.name}"을(를) 삭제할까요?\n인덱스도 함께 사라지고 디스크 공간이 회수됩니다.`,
                      )
                    )
                      return;
                    if (linkedProjectId === p.id) onLinkChange?.(null);
                    try {
                      const { freedBytes } = await remove(p.id);
                      if (freedBytes > 0) {
                        // Light feedback so the user can see disk was
                        // actually reclaimed (not just a DB row gone).
                        console.info(
                          `[RAG] "${p.name}" 삭제 — ${fmtBytes(freedBytes)} 회수`,
                        );
                      }
                    } catch (e) {
                      window.alert(
                        `삭제 실패: ${e instanceof Error ? e.message : String(e)}`,
                      );
                    }
                  }}
                />
              ))}
            </div>
          )}

          {addOpen ? (
            <AddProjectForm
              compact={projects.length > 0}
              onCancel={projects.length > 0 ? () => setAddOpen(false) : undefined}
              onSubmit={async (payload) => {
                await create(payload);
                setAddOpen(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="pm-add-cta"
              onClick={() => setAddOpen(true)}
            >
              + 새 프로젝트 추가
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Project card ─────────────────────────────────────────────────────

function ProjectCard({
  project: p,
  linkable,
  linked,
  onLink,
  onReindex,
  onDelete,
}: {
  project: Project;
  linkable: boolean;
  linked: boolean;
  onLink: () => void;
  onReindex: () => void;
  onDelete: () => void;
}) {
  const pct =
    p.status === "indexing" && p.progress_total
      ? Math.round((100 * p.progress_done) / p.progress_total)
      : 0;

  const meta = CORPUS_META[p.corpus_type] ?? CORPUS_META.code;
  return (
    <article className={`pm-card status-${p.status}${linked ? " linked" : ""}`}>
      <div className="pm-card-head">
        <div className="pm-card-title">
          <span className="pm-card-icon" aria-hidden>
            {p.source_type === "git" ? "🔗" : "📁"}
          </span>
          <span className="pm-card-name" title={p.name}>{p.name}</span>
          <span
            className={`pm-corpus-chip corpus-${p.corpus_type}`}
            title={meta.hint}
          >
            {meta.icon} {meta.label}
          </span>
          {linked && (
            <span className="pm-card-linked-badge" title="현재 채팅에 연결됨">
              ✓ 현재 채팅
            </span>
          )}
        </div>
        <StatusBadge status={p.status} />
      </div>

      <div className="pm-card-source" title={p.source_ref}>
        {p.source_ref}
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
        <div className="pm-card-error">⚠ {p.error}</div>
      )}

      <div className="pm-card-actions">
        {linkable && p.status === "ready" && (
          <button
            type="button"
            className={`pm-link-btn${linked ? " linked" : ""}`}
            onClick={onLink}
          >
            {linked ? "✓ 연결됨" : "이 채팅에 연결"}
          </button>
        )}
        {(p.status === "ready" || p.status === "failed") && (
          <button
            type="button"
            className="pm-icon-btn"
            onClick={onReindex}
            title="다시 인덱싱"
            aria-label="다시 인덱싱"
          >
            🔄
          </button>
        )}
        <button
          type="button"
          className="pm-icon-btn danger"
          onClick={onDelete}
          title="삭제"
          aria-label="삭제"
        >
          🗑
        </button>
      </div>
    </article>
  );
}

// ── Status badge ─────────────────────────────────────────────────────

function StatusBadge({ status }: { status: Project["status"] }) {
  const map = {
    ready: { icon: "✓", label: "준비됨", cls: "ready" },
    indexing: { icon: "⏳", label: "인덱싱 중", cls: "indexing" },
    pending: { icon: "○", label: "대기", cls: "pending" },
    failed: { icon: "✕", label: "실패", cls: "failed" },
  } as const;
  const s = map[status];
  return (
    <span className={`pm-badge ${s.cls}`}>
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}

// ── Add-project form ─────────────────────────────────────────────────

function AddProjectForm({
  compact,
  onCancel,
  onSubmit,
}: {
  compact: boolean;
  onCancel?: () => void;
  onSubmit: (payload: {
    name: string;
    source_type: "folder" | "git";
    source_ref: string;
    ref?: string;
    corpus_type: CorpusType;
  }) => Promise<void>;
}) {
  const [sourceType, setSourceType] = useState<"git" | "folder">("git");
  const [corpusType, setCorpusType] = useState<CorpusType>("code");
  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [ref, setRef] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const sourceRef = sourceType === "git" ? gitUrl.trim() : folderPath.trim();
    if (!sourceRef) {
      setError(
        sourceType === "git"
          ? "Git URL을 입력하세요"
          : "백엔드 서버가 접근 가능한 폴더 절대경로를 입력하세요",
      );
      return;
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
        ref: sourceType === "git" && ref.trim() ? ref.trim() : undefined,
        corpus_type: corpusType,
      });
      setName("");
      setGitUrl("");
      setFolderPath("");
      setRef("");
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
          <div className="pm-add-hero-icon" aria-hidden>📚</div>
          <h4>첫 프로젝트를 추가해보세요</h4>
          <p>Git 레포 URL 또는 백엔드 서버에서 접근 가능한 폴더 경로를 입력하면 백그라운드에서 인덱싱이 시작됩니다.</p>
        </header>
      )}

      <div className="pm-field">
        <label>코퍼스 유형</label>
        <div className="pm-corpus-tabs" role="tablist">
          {(["code", "document", "legal", "api"] as const).map((t) => {
            const m = CORPUS_META[t];
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={corpusType === t}
                className={corpusType === t ? "active" : ""}
                onClick={() => setCorpusType(t)}
              >
                <span aria-hidden>{m.icon}</span>
                <span>{m.label}</span>
              </button>
            );
          })}
        </div>
        <div className="pm-help">{CORPUS_META[corpusType].hint}</div>
      </div>

      <div className="pm-source-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={sourceType === "git"}
          className={sourceType === "git" ? "active" : ""}
          onClick={() => setSourceType("git")}
        >
          🔗 Git URL
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sourceType === "folder"}
          className={sourceType === "folder" ? "active" : ""}
          onClick={() => setSourceType("folder")}
        >
          📁 서버 폴더
        </button>
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

      {sourceType === "git" ? (
        <>
          <div className="pm-field">
            <label htmlFor="pm-git-url">Git URL</label>
            <input
              id="pm-git-url"
              type="text"
              placeholder="https://github.com/owner/repo.git"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              disabled={submitting}
            />
            <div className="pm-help">
              허용 호스트: github / gitlab / bitbucket / codeberg / sr.ht
            </div>
          </div>
          <div className="pm-field">
            <label htmlFor="pm-ref">브랜치 / 태그 (선택)</label>
            <input
              id="pm-ref"
              type="text"
              placeholder="기본 브랜치 사용 (예: main, v1.0)"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              disabled={submitting}
            />
          </div>
        </>
      ) : (
        <div className="pm-field">
          <label htmlFor="pm-folder">서버 절대경로</label>
          <input
            id="pm-folder"
            type="text"
            placeholder="/workspace/projects/egov"
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
            disabled={submitting}
          />
          <div className="pm-help">
            백엔드 서버 자체가 읽을 수 있는 경로여야 합니다. Windows라면 <code>C:/Users/i/git/egov</code> 식으로.
          </div>
        </div>
      )}

      {error && <div className="pm-add-error">⚠ {error}</div>}

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
          {submitting ? "추가 중..." : "+ 인덱싱 시작"}
        </button>
      </div>
    </section>
  );
}
