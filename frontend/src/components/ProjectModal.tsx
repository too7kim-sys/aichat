import { useEffect, useState } from "react";
import type { CorpusType, Project, SourceType } from "../api/client";
import { useProjects } from "../state/ProjectsContext";

const CORPUS_META: Record<
  CorpusType,
  {
    label: string;
    icon: string;
    hint: string;
    /** Connection methods allowed for this corpus type. Order in the
     *  UI matches the order here — the first entry becomes the
     *  default selection when the corpus tab changes. */
    sources: SourceType[];
  }
> = {
  code: {
    label: "코드",
    icon: "💻",
    hint: "소스 트리(.py / .ts / .java / …). 함수 단위 검색에 강함.",
    sources: ["git", "folder"],
  },
  document: {
    label: "문서",
    icon: "📄",
    hint: "PDF·DOCX·MD가 든 폴더 또는 문서 Git 레포. 단락 단위 검색.",
    sources: ["folder", "git"],
  },
  api: {
    label: "API",
    icon: "🔌",
    hint: "OpenAPI/Swagger URL 직접 fetch, 또는 .json/.yaml이 든 폴더.",
    sources: ["url", "folder", "git"],
  },
  db: {
    label: "DB",
    icon: "🗄",
    hint:
      "DB에 직접 접속해 스키마를 리플렉션. CREATE TABLE/VIEW/PROC 단위 분할.",
    sources: ["connection"],
  },
};

const SOURCE_META: Record<
  SourceType,
  {
    label: string;
    icon: string;
    placeholder: string;
    help: string;
    inputType?: "url" | "text" | "password";
  }
> = {
  git: {
    label: "Git URL",
    icon: "🔗",
    placeholder: "https://github.com/owner/repo.git",
    help: "허용 호스트: github / gitlab / bitbucket / codeberg / sr.ht",
    inputType: "url",
  },
  folder: {
    label: "서버 폴더",
    icon: "📁",
    placeholder: "/workspace/projects/egov",
    help:
      "백엔드 서버가 직접 읽을 수 있는 절대경로. Windows라면 C:/Users/i/git/foo 식.",
  },
  url: {
    label: "API URL",
    icon: "🌐",
    placeholder: "https://api.example.com/openapi.json",
    help:
      "OpenAPI/Swagger 스펙이 응답되는 HTTPS 엔드포인트. 30초 fetch, 10 MB 한도.",
    inputType: "url",
  },
  connection: {
    label: "DB 연결",
    icon: "🗄",
    placeholder: "postgresql://user:pass@host:5432/dbname",
    help:
      "지원: postgresql / mysql / mariadb / sqlite. 읽기 전용 reflection만 수행합니다.",
    inputType: "password",
  },
};

/** Hide DB credentials when rendering a project's source_ref. */
function maskSourceRef(sourceType: SourceType, ref: string): string {
  if (sourceType !== "connection") return ref;
  // postgresql://user:pass@host/db → postgresql://user:***@host/db
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
  const { activateSnapshot, deleteSnapshot } = useProjects();
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const pct =
    p.status === "indexing" && p.progress_total
      ? Math.round((100 * p.progress_done) / p.progress_total)
      : 0;
  const totalSnapshots = p.snapshots?.length ?? 0;
  const currentSnapshot = p.snapshots?.find(
    (s) => s.id === p.current_snapshot_id,
  );

  const meta = CORPUS_META[p.corpus_type] ?? CORPUS_META.code;
  return (
    <article className={`pm-card status-${p.status}${linked ? " linked" : ""}`}>
      <div className="pm-card-head">
        <div className="pm-card-title">
          <span className="pm-card-icon" aria-hidden>
            {SOURCE_META[p.source_type]?.icon ?? "📁"}
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
        <div className="pm-card-error">⚠ {p.error}</div>
      )}

      {totalSnapshots > 0 && (
        <div className="pm-snap-block">
          <button
            type="button"
            className="pm-snap-toggle"
            onClick={() => setSnapshotsOpen((v) => !v)}
            aria-expanded={snapshotsOpen}
          >
            <span aria-hidden>{snapshotsOpen ? "▾" : "▸"}</span>
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
                            🗑
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
            title="새 스냅샷으로 다시 인덱싱 (이전 스냅샷 유지)"
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
    source_type: SourceType;
    source_ref: string;
    ref?: string;
    corpus_type: CorpusType;
  }) => Promise<void>;
}) {
  const [corpusType, setCorpusType] = useState<CorpusType>("code");
  const [sourceType, setSourceType] = useState<SourceType>(
    CORPUS_META.code.sources[0],
  );
  // One input value per source type so switching the source tab
  // doesn't wipe what the user already typed in another tab.
  const [refs, setRefs] = useState<Record<SourceType, string>>({
    git: "",
    folder: "",
    url: "",
    connection: "",
  });
  const [name, setName] = useState("");
  const [gitBranch, setGitBranch] = useState("");
  const [submitting, setSubmitting] = useState(false);
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

  async function submit() {
    setError(null);
    const sourceRef = (refs[sourceType] || "").trim();
    if (!sourceRef) {
      setError(`${sourceMeta.label}을(를) 입력하세요`);
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
        ref:
          sourceType === "git" && gitBranch.trim()
            ? gitBranch.trim()
            : undefined,
        corpus_type: corpusType,
      });
      setName("");
      setRefs({ git: "", folder: "", url: "", connection: "" });
      setGitBranch("");
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
          <p>
            코퍼스 유형을 고르면 그에 맞는 연결 방식을 선택할 수 있습니다.
            (코드는 Git/폴더, API는 URL, DB는 연결 문자열 …)
          </p>
        </header>
      )}

      <div className="pm-field">
        <label>코퍼스 유형</label>
        <div className="pm-corpus-tabs" role="tablist">
          {(["code", "document", "api", "db"] as const).map((t) => {
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
        <div className="pm-help">{corpusMeta.hint}</div>
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

      <div className="pm-field">
        <label htmlFor="pm-source-ref">{sourceMeta.label}</label>
        <input
          id="pm-source-ref"
          type={sourceMeta.inputType ?? "text"}
          placeholder={sourceMeta.placeholder}
          value={refs[sourceType]}
          onChange={(e) =>
            setRefs((prev) => ({ ...prev, [sourceType]: e.target.value }))
          }
          disabled={submitting}
          autoComplete={
            sourceType === "connection" ? "off" : undefined
          }
        />
        <div className="pm-help">{sourceMeta.help}</div>
      </div>

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
