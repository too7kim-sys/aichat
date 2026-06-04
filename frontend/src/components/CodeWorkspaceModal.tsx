import { useEffect, useState } from "react";
import { api, type Workspace, type WorkspaceFile } from "../api/client";
import { useWorkspaces } from "../state/WorkspacesContext";
import {
  IconAlertTriangle,
  IconCode,
  IconGitBranch,
  IconPaperclip,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from "./Icon";
import { WorkspaceTree } from "./WorkspaceTree";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Hand the selected file off to ChatPanel as an attachment. */
  onAttachFile?: (filename: string, text: string) => void;
}

function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function CodeWorkspaceModal({ open, onClose, onAttachFile }: Props) {
  const { workspaces, create, remove, sync, refresh } = useWorkspaces();
  const [addOpen, setAddOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    refresh();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, refresh]);

  useEffect(() => {
    if (open && workspaces.length === 0) setAddOpen(true);
  }, [open, workspaces.length]);

  if (!open) return null;
  const active = workspaces.find((w) => w.id === activeId) ?? null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal cw-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="pm-head">
          <div className="pm-head-text">
            <h3>코드 워크스페이스</h3>
            <p>
              사내 Git 레포를 서버에 clone해 파일을 보고 채팅에 붙입니다.
              수정·커밋·푸시는 곧 추가됩니다.
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="닫기"
          >
            <IconX size={18} />
          </button>
        </header>

        {addOpen ? (
          // ── Add-only view ──
          // When the user is creating a workspace we hide the list +
          // viewer entirely so the form has the full modal width and
          // they aren't visually pulled in two directions. The "목록
          // 으로" link goes back to the browsing view.
          <div className="cw-body cw-body-add">
            <div className="cw-add-header">
              <button
                type="button"
                className="cw-back-btn"
                onClick={() => setAddOpen(false)}
                disabled={workspaces.length === 0}
                title={
                  workspaces.length === 0
                    ? "최소 한 개를 먼저 추가해야 목록으로 돌아갈 수 있습니다"
                    : "목록으로"
                }
              >
                ← 목록으로
              </button>
              <h4>새 워크스페이스 추가</h4>
            </div>
            <div className="cw-add-wrap">
              <AddWorkspaceForm
                onCancel={() => setAddOpen(false)}
                onSubmit={async (payload) => {
                  const created = await create(payload);
                  setAddOpen(false);
                  setActiveId(created.id);
                }}
              />
            </div>
          </div>
        ) : (
          // ── Browse view ── list + detail
          <div className="cw-body">
            <aside className="cw-list">
              <button
                type="button"
                className="pm-add-cta cw-add-cta"
                onClick={() => setAddOpen(true)}
              >
                <IconPlus size={14} />
                <span>워크스페이스 추가</span>
              </button>

              {workspaces.length === 0 && (
                <div className="cw-empty">
                  <IconCode size={32} />
                  <p>첫 워크스페이스를 추가해보세요.</p>
                </div>
              )}

              <ul className="cw-ws-list">
                {workspaces.map((w) => (
                  <li
                    key={w.id}
                    className={`cw-ws-item status-${w.status}${
                      activeId === w.id ? " active" : ""
                    }`}
                    onClick={() => setActiveId(w.id)}
                  >
                    <div className="cw-ws-top">
                      <span className="cw-ws-name">
                        <IconGitBranch size={13} /> {w.name}
                      </span>
                      <button
                        type="button"
                        className="cw-ws-del"
                        title="삭제"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (
                            !window.confirm(
                              `"${w.name}" 워크스페이스를 삭제할까요?\n로컬 clone도 함께 사라집니다.`,
                            )
                          )
                            return;
                          await remove(w.id);
                          if (activeId === w.id) setActiveId(null);
                        }}
                      >
                        <IconTrash size={12} />
                      </button>
                    </div>
                    <div className="cw-ws-meta">
                      <span className={`cw-ws-status status-${w.status}`}>
                        {w.status === "ready"
                          ? "준비됨"
                          : w.status === "cloning"
                          ? "클론 중…"
                          : "실패"}
                      </span>
                      {w.status === "ready" && (
                        <span>
                          {w.file_count}f · {fmtBytes(w.size_bytes)}
                        </span>
                      )}
                    </div>
                    {w.status === "failed" && w.error && (
                      <div className="cw-ws-error">
                        <IconAlertTriangle size={11} /> {w.error.slice(0, 80)}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </aside>

            <main className="cw-main">
              {active && active.status === "ready" ? (
                <WorkspaceView
                  workspace={active}
                  onSync={() => sync(active.id)}
                  onAttachFile={(filename, text) => {
                    onAttachFile?.(filename, text);
                    onClose();
                  }}
                />
              ) : (
                <div className="cw-main-empty">
                  {active
                    ? active.status === "cloning"
                      ? "클론 중입니다. 잠시만 기다려 주세요…"
                      : active.error || "준비되지 않음"
                    : "왼쪽에서 워크스페이스를 선택하세요"}
                </div>
              )}
            </main>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Workspace view (tree + file) ──────────────────────────────────────

function WorkspaceView({
  workspace,
  onSync,
  onAttachFile,
}: {
  workspace: Workspace;
  onSync: () => Promise<void> | void;
  onAttachFile: (filename: string, text: string) => void;
}) {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    setFilePath(null);
    setFile(null);
  }, [workspace.id, workspace.last_synced_at]);

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    api
      .workspaceFile(workspace.id, filePath)
      .then((res) => {
        if (!cancelled) setFile(res);
      })
      .catch((e) => {
        if (!cancelled)
          setFile({
            path: filePath,
            text: `[로드 실패: ${e instanceof Error ? e.message : String(e)}]`,
            size: 0,
            truncated: false,
            method: "error",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.id, filePath]);

  return (
    <div className="cw-view">
      <header className="cw-view-head">
        <div>
          <div className="cw-view-name">{workspace.name}</div>
          <div className="cw-view-url" title={workspace.git_url}>
            {workspace.git_url}
            {workspace.branch && ` · ${workspace.branch}`}
          </div>
        </div>
        <button
          type="button"
          className="cw-sync-btn"
          disabled={syncing}
          onClick={async () => {
            setSyncing(true);
            try {
              await onSync();
            } finally {
              setSyncing(false);
            }
          }}
        >
          <IconRefresh size={13} />
          {syncing ? "동기화 중…" : "동기화 (git pull)"}
        </button>
      </header>

      <div className="cw-split">
        <div className="cw-tree">
          <WorkspaceTree
            workspaceId={workspace.id}
            activePath={filePath}
            onSelectFile={setFilePath}
            refreshKey={workspace.last_synced_at ?? undefined}
          />
        </div>
        <div className="cw-file">
          {file ? (
            <>
              <div className="cw-file-head">
                <span className="cw-file-path">{file.path}</span>
                <span className="cw-file-meta">
                  {fmtBytes(file.size)}
                  {file.truncated && " · truncated"}
                </span>
                <button
                  type="button"
                  className="cw-attach-btn"
                  disabled={
                    file.method === "binary-skipped" ||
                    file.method === "too-large"
                  }
                  onClick={() => onAttachFile(file.path, file.text)}
                  title="현재 채팅에 첨부"
                >
                  <IconPaperclip size={13} /> 채팅에 첨부
                </button>
              </div>
              <pre className="cw-file-body">{file.text}</pre>
            </>
          ) : (
            <div className="cw-tree-loading">
              {filePath ? "파일 로드 중…" : "왼쪽에서 파일을 선택하세요"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// ── Add workspace form ────────────────────────────────────────────────

function AddWorkspaceForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (payload: {
    name: string;
    git_url: string;
    branch?: string;
    auth_username?: string;
    auth_token?: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [user, setUser] = useState("");
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!name.trim()) {
      setError("이름을 입력하세요");
      return;
    }
    if (!gitUrl.trim()) {
      setError("Git URL을 입력하세요");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        git_url: gitUrl.trim(),
        branch: branch.trim() || undefined,
        auth_username: user.trim() || undefined,
        auth_token: token || undefined,
      });
      setName("");
      setGitUrl("");
      setBranch("");
      setUser("");
      setToken("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="pm-add compact cw-add">
      <div className="pm-field">
        <label>이름</label>
        <input
          type="text"
          placeholder="예: 사내 결제 모듈"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
        />
      </div>
      <div className="pm-field">
        <label>Git URL</label>
        <input
          type="url"
          placeholder="https://gitlab.internal/team/payments.git"
          value={gitUrl}
          onChange={(e) => setGitUrl(e.target.value)}
          disabled={submitting}
        />
        <div className="pm-help">http(s) URL. 사내 호스트는 .env의 WORKSPACE_ALLOWED_HOSTS로 제한 가능.</div>
      </div>
      <div className="pm-field">
        <label>브랜치 (선택)</label>
        <input
          type="text"
          placeholder="main / develop"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          disabled={submitting}
        />
      </div>
      <div className="pm-field">
        <label>사용자명 (선택)</label>
        <input
          type="text"
          autoComplete="username"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          disabled={submitting}
        />
      </div>
      <div className="pm-field">
        <label>PAT / 비밀번호 (선택)</label>
        <input
          type="password"
          autoComplete="new-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={submitting}
        />
        <div className="pm-help">
          서버에 Fernet으로 암호화 저장됩니다. 공개 레포는 비워두세요.
        </div>
      </div>

      {error && (
        <div className="pm-add-error">
          <IconAlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      <div className="pm-add-actions">
        <button type="button" className="pm-btn-secondary" onClick={onCancel}>
          취소
        </button>
        <button
          type="button"
          className="pm-btn-primary"
          onClick={submit}
          disabled={submitting}
        >
          {submitting ? "clone 중…" : "추가 + clone"}
        </button>
      </div>
    </section>
  );
}
