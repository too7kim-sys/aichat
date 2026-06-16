import { Suspense, lazy, useEffect, useState } from "react";
import { api, type Workspace, type WorkspaceFile } from "../api/client";

// Monaco 는 무거운 의존성이라 lazy + Suspense 로 분리. 평소 트리만 보고
// 파일 안 여는 경우엔 다운로드도 안 함.
const MonacoEditor = lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.default })),
);
import { useWorkspaces } from "../state/WorkspacesContext";
import {
  IconAlertTriangle,
  IconCode,
  IconFolder,
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
              사내 Git 레포를 clone하거나 서버의 로컬 폴더를 등록해 파일을 보고
              채팅에 붙이고, LLM이 만든 패치를 적용·커밋·푸시할 수 있습니다.
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
                        {w.source_type === "local" ? (
                          <IconFolder size={13} />
                        ) : (
                          <IconGitBranch size={13} />
                        )}{" "}
                        {w.name}
                      </span>
                      <button
                        type="button"
                        className="cw-ws-del"
                        title="삭제"
                        onClick={async (e) => {
                          e.stopPropagation();
                          const detail =
                            w.source_type === "local"
                              ? "등록만 해제되며 디스크의 폴더는 그대로 남습니다."
                              : "로컬 clone도 함께 사라집니다.";
                          if (
                            !window.confirm(
                              `"${w.name}" 워크스페이스를 삭제할까요?\n${detail}`,
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
  // goto-line 보류 — outline/grep/symbol 패널이 디스패치한 라인을 받아
  // Monaco onMount 직후 reveal 한다 (#88).
  const [pendingLine, setPendingLine] = useState<number | null>(null);
  // Monaco editor instance — onMount 콜백에서 채워짐.
  const editorRef = (window as unknown as { _wsEditor?: unknown }) as {
    _wsEditor?: { revealLineInCenter: (n: number) => void; setPosition: (p: { lineNumber: number; column: number }) => void };
  };
  // ws:goto-line 이벤트 listener — 파일 전환 + 라인 점프.
  useEffect(() => {
    function onGoto(e: Event) {
      const ev = e as CustomEvent<{ path: string; line: number }>;
      const p = ev.detail?.path;
      const ln = ev.detail?.line;
      if (!p || !ln) return;
      if (p !== filePath) setFilePath(p);
      setPendingLine(ln);
      // 같은 파일이면 즉시 reveal.
      if (p === filePath && editorRef._wsEditor) {
        editorRef._wsEditor.revealLineInCenter(ln);
        editorRef._wsEditor.setPosition({ lineNumber: ln, column: 1 });
      }
    }
    window.addEventListener("ws:goto-line", onGoto);
    return () => window.removeEventListener("ws:goto-line", onGoto);
  }, [filePath]);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  // 인앱 편집기 (#53) — Monaco 에서 사용자가 수정하면 originalText 와
  // 다르면 dirty=true 로 표시, 저장 버튼 활성.
  const [editText, setEditText] = useState<string>("");
  const [originalText, setOriginalText] = useState<string>("");
  const [saving, setSaving] = useState(false);
  // 마크다운 미리보기 토글 (#79). .md 파일에만 의미 있어 평소엔 false.
  const [mdPreview, setMdPreview] = useState(false);
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
        if (!cancelled) {
          setFile(res);
          setOriginalText(res.text || "");
          setEditText(res.text || "");
        }
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
          <div
            className="cw-view-url"
            title={workspace.source_type === "local" ? "인앱 작업공간 (서버 자동 관리)" : workspace.git_url}
          >
            {workspace.source_type === "local" ? (
              <>📁 인앱 작업공간</>
            ) : (
              <>
                {workspace.git_url}
                {workspace.branch && ` · ${workspace.branch}`}
              </>
            )}
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
          title={
            workspace.source_type === "local"
              ? "트리 다시 스캔"
              : "원격에서 최신 변경 가져오기 (git pull)"
          }
        >
          <IconRefresh size={13} />
          {syncing
            ? workspace.source_type === "local"
              ? "스캔 중…"
              : "동기화 중…"
            : workspace.source_type === "local"
            ? "트리 새로고침"
            : "동기화 (git pull)"}
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
                <span className="cw-file-path">
                  {file.path}
                  {editText !== originalText && (
                    <span className="cw-file-dirty"> ● 수정됨</span>
                  )}
                </span>
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
                  onClick={() => onAttachFile(file.path, editText)}
                  title="현재 채팅에 첨부"
                >
                  <IconPaperclip size={13} /> 채팅에 첨부
                </button>
                <button
                  type="button"
                  className="cw-attach-btn"
                  disabled={
                    saving ||
                    editText === originalText ||
                    file.method === "binary-skipped" ||
                    file.method === "too-large"
                  }
                  onClick={async () => {
                    setSaving(true);
                    try {
                      await api.saveWorkspaceFile(
                        workspace.id,
                        file.path,
                        editText,
                      );
                      setOriginalText(editText);
                    } catch (e) {
                      window.alert(
                        `저장 실패: ${e instanceof Error ? e.message : String(e)}`,
                      );
                    } finally {
                      setSaving(false);
                    }
                  }}
                  title="이 파일을 워크스페이스에 저장"
                >
                  💾 {saving ? "저장 중…" : "저장"}
                </button>
                {/\.(md|markdown)$/i.test(file.path) && (
                  <button
                    type="button"
                    className="cw-attach-btn"
                    onClick={() => setMdPreview((v) => !v)}
                    title="raw ↔ 마크다운 렌더링"
                  >
                    {mdPreview ? "📝 원문" : "📖 미리보기"}
                  </button>
                )}
              </div>
              {file.method === "binary-skipped" || file.method === "too-large" ? (
                <pre className="cw-file-body">{file.text}</pre>
              ) : mdPreview && /\.(md|markdown)$/i.test(file.path) ? (
                <Suspense fallback={<pre className="cw-file-body">렌더 중…</pre>}>
                  <MarkdownPreview text={editText} />
                </Suspense>
              ) : (
                <Suspense
                  fallback={
                    <pre className="cw-file-body">에디터 로딩 중…</pre>
                  }
                >
                  <MonacoEditor
                    height="60vh"
                    language={detectLanguage(file.path)}
                    value={editText}
                    theme={
                      document.documentElement.getAttribute("data-theme") === "dark"
                        ? "vs-dark"
                        : "light"
                    }
                    onChange={(v) => setEditText(v || "")}
                    onMount={(editor) => {
                      // 윈도우에 보관 — useEffect 가 evt 처리 시 참조.
                      // ws:goto-line 이벤트 dispatch 가 발생하면 reveal.
                      (window as unknown as { _wsEditor?: typeof editor })._wsEditor = editor;
                      if (pendingLine) {
                        editor.revealLineInCenter(pendingLine);
                        editor.setPosition({ lineNumber: pendingLine, column: 1 });
                        setPendingLine(null);
                      }
                    }}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 13,
                      wordWrap: "on",
                      automaticLayout: true,
                      scrollBeyondLastLine: false,
                    }}
                  />
                </Suspense>
              )}
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

interface Constraints {
  allowed_hosts: string[];
  local_roots: string[];
  max_files: number;
  max_size_mb: number;
  clone_depth: number;
  bundle_max_files: number;
  bundle_max_total_bytes: number;
  bundle_max_per_file_bytes: number;
}

function fmtMB(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function tryParseHost(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function AddWorkspaceForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (payload: {
    name: string;
    source_type: "git" | "local";
    git_url?: string;
    branch?: string;
    auth_username?: string;
    auth_token?: string;
    local_path?: string;
  }) => Promise<void>;
}) {
  const [sourceType, setSourceType] = useState<"git" | "local">("git");
  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [user, setUser] = useState("");
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live server-side constraints — populated on mount so the form
  // can show the user what's allowed AND preflight-check input
  // against the allow-lists before the request hits the server.
  const [constraints, setConstraints] = useState<Constraints | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .workspaceConstraints()
      .then((c) => {
        if (!cancelled) setConstraints(c);
      })
      .catch(() => {
        /* ignore — form still works, the server will validate */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Preflight: does this input violate one of the known constraints?
  // Returns a user-facing message or null if it looks fine. Server
  // validation is still authoritative — this is just an early signal
  // so the user can fix it without round-tripping.
  // Local-folder workspaces no longer take a server path (the previous
  // input exposed the server filesystem to users). They're auto-
  // provisioned as an empty managed directory, so there's nothing to
  // preflight on that side.
  function preflight(): string | null {
    if (!constraints) return null;
    if (sourceType !== "git") return null;
    const host = tryParseHost(gitUrl.trim());
    if (!host) return "유효한 http(s) URL이 아닙니다";
    if (
      constraints.allowed_hosts.length > 0 &&
      !constraints.allowed_hosts.includes(host)
    ) {
      return `호스트 '${host}'는 허용 목록에 없습니다. 허용: ${constraints.allowed_hosts.join(", ")}`;
    }
    return null;
  }

  async function submit() {
    setError(null);
    if (!name.trim()) {
      setError("이름을 입력하세요");
      return;
    }
    if (sourceType === "git") {
      if (!gitUrl.trim()) {
        setError("Git URL을 입력하세요");
        return;
      }
    }
    const pre = preflight();
    if (pre) {
      setError(pre);
      return;
    }
    setSubmitting(true);
    try {
      if (sourceType === "git") {
        await onSubmit({
          name: name.trim(),
          source_type: "git",
          git_url: gitUrl.trim(),
          branch: branch.trim() || undefined,
          auth_username: user.trim() || undefined,
          auth_token: token || undefined,
        });
      } else {
        await onSubmit({
          name: name.trim(),
          source_type: "local",
        });
      }
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
      <div className="cw-source-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={sourceType === "git"}
          className={`cw-source-tab${sourceType === "git" ? " active" : ""}`}
          onClick={() => setSourceType("git")}
          disabled={submitting}
        >
          <IconGitBranch size={13} /> Git 클론
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sourceType === "local"}
          className={`cw-source-tab${sourceType === "local" ? " active" : ""}`}
          onClick={() => setSourceType("local")}
          disabled={submitting}
        >
          <IconFolder size={13} /> 로컬 폴더
        </button>
      </div>

      {constraints && (
        <details className="cw-constraints">
          <summary>
            <IconAlertTriangle size={12} />
            <span>제약 사항 보기 (서버 설정)</span>
          </summary>
          <ul className="cw-constraints-list">
            {sourceType === "git" ? (
              <>
                <li>
                  <span className="cw-c-key">허용 호스트</span>
                  <span className="cw-c-val">
                    {constraints.allowed_hosts.length === 0
                      ? "모든 호스트 (제한 없음)"
                      : constraints.allowed_hosts.join(", ")}
                  </span>
                </li>
                <li>
                  <span className="cw-c-key">클론 깊이</span>
                  <span className="cw-c-val">
                    --depth {constraints.clone_depth}
                  </span>
                </li>
                <li>
                  <span className="cw-c-key">스킴</span>
                  <span className="cw-c-val">http(s)만 지원 (ssh:// 불가)</span>
                </li>
              </>
            ) : (
              <>
                <li>
                  <span className="cw-c-key">저장 위치</span>
                  <span className="cw-c-val">
                    서버 안 작업공간 (자동 관리). 채팅에서 생성한 코드가
                    여기로 저장되고 트리에 보입니다.
                  </span>
                </li>
                <li>
                  <span className="cw-c-key">삭제 정책</span>
                  <span className="cw-c-val">
                    워크스페이스 삭제 시 서버 파일도 함께 정리됩니다.
                  </span>
                </li>
              </>
            )}
            <li>
              <span className="cw-c-key">트리 한도</span>
              <span className="cw-c-val">
                최대 {constraints.max_files.toLocaleString()}개 파일 /{" "}
                {constraints.max_size_mb} MB
              </span>
            </li>
            <li>
              <span className="cw-c-key">채팅 자동첨부</span>
              <span className="cw-c-val">
                최대 {constraints.bundle_max_files}개 파일 / 총{" "}
                {fmtMB(constraints.bundle_max_total_bytes)} / 파일당{" "}
                {fmtMB(constraints.bundle_max_per_file_bytes)}
                <br />
                <small>
                  ※ 이 한도 안이면 매 턴 트리의 모든 파일이 자동 전달됩니다.
                  초과 시 트리에서 클릭해 추가하세요.
                </small>
              </span>
            </li>
          </ul>
        </details>
      )}

      <div className="pm-field">
        <label>이름</label>
        <input
          type="text"
          placeholder={
            sourceType === "git" ? "예: 사내 결제 모듈" : "예: 내 로컬 작업물"
          }
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
        />
      </div>

      {sourceType === "git" ? (
        <>
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
        </>
      ) : (
        <div className="pm-field cw-local-info">
          <label>인앱 작업공간</label>
          <div className="pm-help">
            서버 안에 빈 작업공간이 자동으로 만들어집니다. 별도 폴더 경로를
            입력할 필요가 없고, 채팅에서 생성한 소스 파일이 이 작업공간 트리에
            그대로 보입니다. 워크스페이스를 삭제하면 서버의 파일도 함께
            정리됩니다.
          </div>
        </div>
      )}

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
          {submitting
            ? sourceType === "git" ? "clone 중…" : "생성 중…"
            : sourceType === "git" ? "추가 + clone" : "작업공간 생성"}
        </button>
      </div>
    </section>
  );
}


// Monaco 의 language id 로 매핑 — 추론 실패하면 plaintext 폴백.
function detectLanguage(path: string): string {
  const ext = (path.split(".").pop() || "").toLowerCase();
  const map: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    pyi: "python",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    cs: "csharp",
    rb: "ruby",
    php: "php",
    swift: "swift",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    sql: "sql",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "ini",
    ini: "ini",
    md: "markdown",
    markdown: "markdown",
    xml: "xml",
    vue: "html",
    svelte: "html",
    dockerfile: "dockerfile",
    makefile: "makefile",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cc: "cpp",
  };
  return map[ext] || "plaintext";
}


// 마크다운 미리보기 (#79) — 기존 MarkdownContent 재활용.  Suspense
// 안에서 호출되므로 일반 import 도 OK 지만, ChatPanel 외부 사용을
// 분명히 하기 위해 lazy.
const MarkdownContent = lazy(() =>
  import("./MarkdownContent").then((m) => ({ default: m.MarkdownContent })),
);

function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="cw-md-preview">
      <MarkdownContent content={text} />
    </div>
  );
}
