import { useEffect, useState } from "react";
import type { Project } from "../api/client";
import { useProjects } from "../state/ProjectsContext";

interface Props {
  open: boolean;
  onClose: () => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /**
   * When true (default), each ready project shows an "이 채팅에 연결"
   * button that wires it to the current chat session. Set false when
   * opening from a context where no chat is active (e.g. the Cowork
   * sidebar's project manager).
   */
  linkable?: boolean;
}

function statusBadge(p: Project): { label: string; cls: string } {
  switch (p.status) {
    case "ready":
      return { label: "준비됨", cls: "ready" };
    case "indexing": {
      const pct = p.progress_total
        ? Math.round((100 * p.progress_done) / p.progress_total)
        : 0;
      return { label: `인덱싱 ${pct}%`, cls: "indexing" };
    }
    case "pending":
      return { label: "대기", cls: "pending" };
    case "failed":
      return { label: "실패", cls: "failed" };
    default:
      return { label: p.status, cls: "" };
  }
}

export function ProjectModal({
  open,
  onClose,
  selectedId,
  onSelect,
  linkable = true,
}: Props) {
  const { projects, create, remove, reindex, refresh } = useProjects();
  const [sourceType, setSourceType] = useState<"folder" | "git">("git");
  const [name, setName] = useState("");
  const [ref, setRef] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    refresh();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, refresh]);

  if (!open) return null;

  async function submit() {
    setError(null);
    const sourceRef = sourceType === "git" ? gitUrl.trim() : folderPath.trim();
    if (!sourceRef) {
      setError(
        sourceType === "git"
          ? "Git URL을 입력하세요"
          : "서버에서 접근 가능한 폴더 절대경로를 입력하세요",
      );
      return;
    }
    if (!name.trim()) {
      setError("프로젝트 이름을 입력하세요");
      return;
    }
    setSubmitting(true);
    try {
      await create({
        name: name.trim(),
        source_type: sourceType,
        source_ref: sourceRef,
        ref: sourceType === "git" && ref.trim() ? ref.trim() : undefined,
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
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal projects-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>📚 RAG 프로젝트</h3>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="닫기"
          >
            ×
          </button>
        </div>

        <div className="modal-body">
          <div className="proj-add">
            <div className="proj-tabs">
              <button
                type="button"
                className={sourceType === "git" ? "active" : ""}
                onClick={() => setSourceType("git")}
              >
                Git URL
              </button>
              <button
                type="button"
                className={sourceType === "folder" ? "active" : ""}
                onClick={() => setSourceType("folder")}
              >
                서버 폴더
              </button>
            </div>
            <input
              type="text"
              placeholder="프로젝트 이름 (예: 전자정부 표준프레임워크)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {sourceType === "git" ? (
              <>
                <input
                  type="text"
                  placeholder="https://github.com/owner/repo.git"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="브랜치/태그 (선택, 기본 = 기본 브랜치)"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                />
              </>
            ) : (
              <input
                type="text"
                placeholder="서버 절대경로 (예: /workspace/projects/egov)"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
              />
            )}
            {error && <div className="proj-error">{error}</div>}
            <button
              type="button"
              className="modal-primary"
              onClick={submit}
              disabled={submitting}
            >
              {submitting ? "추가 중..." : "+ 인덱싱 시작"}
            </button>
          </div>

          <div className="proj-list">
            {projects.length === 0 && (
              <div className="proj-empty">
                아직 인덱싱한 프로젝트가 없습니다. 위에서 Git URL이나 폴더 경로를
                넣어 추가하세요.
              </div>
            )}
            {projects.map((p) => {
              const b = statusBadge(p);
              const selected = p.id === selectedId;
              return (
                <div
                  key={p.id}
                  className={`proj-row${selected ? " selected" : ""}`}
                >
                  <div className="proj-main">
                    <div className="proj-row-head">
                      <span className="proj-name">{p.name}</span>
                      <span className={`proj-status ${b.cls}`}>{b.label}</span>
                    </div>
                    <div className="proj-meta">
                      <span className="proj-source">
                        {p.source_type === "git" ? "🔗" : "📁"} {p.source_ref}
                      </span>
                      {p.status === "ready" && (
                        <span>
                          {p.file_count}개 파일 · {p.chunk_count}개 청크
                        </span>
                      )}
                      {p.status === "failed" && p.error && (
                        <span className="proj-error-inline">
                          {p.error.slice(0, 120)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="proj-actions">
                    {linkable && p.status === "ready" && (
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(selected ? null : p.id);
                          onClose();
                        }}
                      >
                        {selected ? "✓ 선택됨" : "이 채팅에 연결"}
                      </button>
                    )}
                    {(p.status === "ready" || p.status === "failed") && (
                      <button
                        type="button"
                        onClick={() => reindex(p.id)}
                      >
                        재인덱싱
                      </button>
                    )}
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        if (window.confirm(`"${p.name}" 삭제할까요?`)) {
                          remove(p.id);
                          if (selected) onSelect(null);
                        }
                      }}
                    >
                      삭제
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="modal-secondary" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
