import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { api, type WorkspaceStatusEntry } from "../api/client";
import { IconAlertTriangle, IconGitBranch, IconRefresh, IconTrash } from "./Icon";

const DiffEditor = lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.DiffEditor })),
);

function detectLang(path: string): string {
  const ext = (path.split(".").pop() || "").toLowerCase();
  const map: Record<string, string> = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", py: "python", go: "go", rs: "rust",
    java: "java", kt: "kotlin", cs: "csharp", rb: "ruby", php: "php",
    swift: "swift", sh: "shell", bash: "shell", sql: "sql",
    html: "html", css: "css", scss: "scss", less: "less",
    json: "json", yaml: "yaml", yml: "yaml", toml: "ini",
    md: "markdown", xml: "xml", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  };
  return map[ext] || "plaintext";
}

interface Props {
  workspaceId: string;
  /** Optional bump key — any time the parent applies a patch it
   * increments this so we re-poll status without remounting. */
  refreshKey?: number | string;
}

interface DiffViewProps {
  workspaceId: string;
  path: string;
  onClose: () => void;
}

function DiffView({ workspaceId, path, onClose }: DiffViewProps) {
  // 사이드 바이 사이드 (Monaco DiffEditor) 가 기본. 실패하거나 사용자가
  // 토글하면 unified text 로 폴백.
  const [side, setSide] = useState(true);
  const [head, setHead] = useState<string | null>(null);
  const [work, setWork] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setHead(null);
    setWork(null);
    setError(null);
    Promise.all([
      api
        .workspaceFileAtRev(workspaceId, path, "HEAD")
        .then((r) => r.text)
        .catch(() => ""),
      api
        .workspaceFile(workspaceId, path)
        .then((r) => r.text)
        .catch(() => null),
      api
        .workspaceDiff(workspaceId, path)
        .then((r) => r.diff)
        .catch((e) => {
          if (!cancelled)
            setError(e instanceof Error ? e.message : String(e));
          return "";
        }),
    ]).then(([h, w, d]) => {
      if (cancelled) return;
      setHead(h);
      setWork(w);
      setDiff(d || "(변경 없음 — 새 파일이거나 동일한 내용)");
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, path]);

  return (
    <div className="wsc-diff-overlay" onClick={onClose}>
      <div className="wsc-diff-box" onClick={(e) => e.stopPropagation()}>
        <header>
          <span className="wsc-diff-path">{path}</span>
          <button
            type="button"
            onClick={() => setSide((v) => !v)}
            className="wsc-diff-close"
            title="사이드 바이 사이드 ↔ 통합 텍스트"
          >
            {side ? "📄 텍스트" : "↔ 사이드"}
          </button>
          <button type="button" onClick={onClose} className="wsc-diff-close">
            닫기
          </button>
        </header>
        {error ? (
          <div className="wsc-diff-error">{error}</div>
        ) : diff === null ? (
          <div className="wsc-diff-loading">diff 로드 중…</div>
        ) : side && head !== null && work !== null ? (
          <Suspense
            fallback={<div className="wsc-diff-loading">에디터 로딩 중…</div>}
          >
            <div className="wsc-diff-monaco">
              <DiffEditor
                height="100%"
                original={head}
                modified={work}
                language={detectLang(path)}
                theme={
                  document.documentElement.getAttribute("data-theme") === "dark"
                    ? "vs-dark"
                    : "light"
                }
                options={{
                  readOnly: true,
                  renderSideBySide: true,
                  minimap: { enabled: false },
                  fontSize: 12.5,
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                }}
              />
            </div>
          </Suspense>
        ) : (
          <pre className="wsc-diff-body">{diff}</pre>
        )}
      </div>
    </div>
  );
}

export function WorkspaceChangesPanel({ workspaceId, refreshKey }: Props) {
  const [entries, setEntries] = useState<WorkspaceStatusEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // false = workspace isn't a git working tree (local folder without
  // .git). We hide the commit/push controls in that case so the user
  // doesn't try to commit and get an error.
  const [isGit, setIsGit] = useState<boolean>(true);
  // Collapse the panel when there's nothing to commit so the chat
  // bottom doesn't carry a permanent "변경된 파일이 없습니다." block
  // unrelated to the active question. The header (with refresh + the
  // dirty-count badge) stays so the user can still trigger a re-scan
  // or expand it manually.
  const [collapsed, setCollapsed] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<
    "idle" | "committing" | "pushing" | "ai-review" | "ai-msg"
  >("idle");
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<"ok" | "err">("ok");
  // AI 리뷰 결과 — 모달 텍스트 (#57).
  const [reviewText, setReviewText] = useState<string | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.workspaceStatus(workspaceId);
      setEntries(res.entries);
      setIsGit(res.git !== false);
      // Drop any selection that no longer exists in the dirty list.
      setSelected((prev) => {
        const valid = new Set(res.entries.map((e) => e.path));
        const next = new Set<string>();
        prev.forEach((p) => valid.has(p) && next.add(p));
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  // Auto-collapse whenever we re-poll and find no changes / not a
  // git repo. Auto-expand when changes appear (so the user can see
  // and act on them immediately). The user can still toggle by
  // clicking the header chevron.
  useEffect(() => {
    if (!isGit) setCollapsed(true);
    else if (entries.length === 0) setCollapsed(true);
    else setCollapsed(false);
  }, [isGit, entries.length]);

  function toggleAll() {
    setSelected((prev) =>
      prev.size === entries.length
        ? new Set()
        : new Set(entries.map((e) => e.path)),
    );
  }

  function toggleOne(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function doCommit(push: boolean) {
    if (!message.trim()) {
      setStatus("커밋 메시지를 입력하세요");
      setStatusKind("err");
      return;
    }
    if (entries.length === 0) {
      setStatus("커밋할 변경이 없습니다");
      setStatusKind("err");
      return;
    }
    setBusy(push ? "pushing" : "committing");
    setStatus(null);
    try {
      // If nothing selected, send empty array (server commits ALL dirty).
      const paths = selected.size > 0 ? Array.from(selected) : [];
      const res = await api.commitWorkspace(workspaceId, {
        message: message.trim(),
        paths,
        push,
      });
      if (!res.commit.committed) {
        setStatus("스테이지된 변경이 없습니다");
        setStatusKind("err");
      } else if (push && res.push && !res.push.pushed) {
        setStatus(
          `커밋 OK (${res.commit.sha?.slice(0, 7)}) · push 실패: ${res.push.error ?? ""}`,
        );
        setStatusKind("err");
      } else if (push) {
        setStatus(
          `커밋 + 푸시 완료 — ${res.commit.sha?.slice(0, 7)} (${res.commit.files.length}개 파일)`,
        );
        setStatusKind("ok");
        setMessage("");
      } else {
        setStatus(
          `커밋 완료 — ${res.commit.sha?.slice(0, 7)} (${res.commit.files.length}개 파일)`,
        );
        setStatusKind("ok");
        setMessage("");
      }
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
      setStatusKind("err");
    } finally {
      setBusy("idle");
    }
  }

  async function revert(path: string) {
    if (
      !window.confirm(`"${path}"의 로컬 변경을 되돌리시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)
    ) {
      return;
    }
    try {
      await api.revertWorkspaceFile(workspaceId, path);
      await refresh();
      setStatus(`되돌림: ${path}`);
      setStatusKind("ok");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
      setStatusKind("err");
    }
  }

  return (
    <section className={`wsc-panel${collapsed ? " collapsed" : ""}`}>
      <header className="wsc-head">
        <button
          type="button"
          className="wsc-title wsc-title-toggle"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "변경사항 펼치기" : "변경사항 접기"}
        >
          <span className="wsc-chevron" aria-hidden>
            {collapsed ? "▸" : "▾"}
          </span>
          <IconGitBranch size={13} /> 변경사항
          {entries.length > 0 && (
            <span className="wsc-count">{entries.length}</span>
          )}
        </button>
        <button
          type="button"
          className="wsc-refresh"
          onClick={refresh}
          disabled={loading}
          title="새로고침"
        >
          <IconRefresh size={12} />
        </button>
      </header>

      {!collapsed && error && (
        <div className="wsc-error">
          <IconAlertTriangle size={12} /> {error}
        </div>
      )}

      {!collapsed && !isGit && !loading && !error && (
        <div className="wsc-empty">
          이 폴더는 git 저장소가 아닙니다.
          <br />
          <small>(LLM 패치 적용은 가능하지만 커밋·푸시는 비활성)</small>
        </div>
      )}

      {!collapsed && isGit && entries.length === 0 && !loading && !error && (
        <div className="wsc-empty">변경된 파일이 없습니다.</div>
      )}

      {!collapsed && entries.length > 0 && (
        <>
          <div className="wsc-toolbar">
            <label className="wsc-select-all">
              <input
                type="checkbox"
                checked={selected.size === entries.length && entries.length > 0}
                onChange={toggleAll}
              />
              <span>
                {selected.size === 0
                  ? "전부 커밋"
                  : `${selected.size}/${entries.length} 선택`}
              </span>
            </label>
          </div>

          <ul className="wsc-list">
            {entries.map((e) => {
              const isSelected = selected.has(e.path);
              return (
                <li key={e.path} className={`wsc-item status-${e.status}`}>
                  <label className="wsc-item-main">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(e.path)}
                    />
                    <span className={`wsc-status-tag s-${e.status}`}>
                      {e.label}
                    </span>
                    <span
                      className="wsc-item-path"
                      title={e.path}
                      onClick={(ev) => {
                        ev.preventDefault();
                        setDiffPath(e.path);
                      }}
                    >
                      {e.path}
                    </span>
                  </label>
                  <button
                    type="button"
                    className="wsc-revert"
                    title="이 파일의 변경을 되돌리기"
                    onClick={() => revert(e.path)}
                  >
                    <IconTrash size={11} />
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="wsc-ai-row">
            <button
              type="button"
              className="wsc-ai-btn"
              disabled={busy !== "idle"}
              onClick={async () => {
                setBusy("ai-review");
                setStatus(null);
                setReviewText(null);
                try {
                  const r = await api.aiReviewWorkspace(workspaceId);
                  setReviewText(r.review);
                } catch (e) {
                  setStatus(
                    `AI 리뷰 실패: ${e instanceof Error ? e.message : String(e)}`,
                  );
                } finally {
                  setBusy("idle");
                }
              }}
              title="현재 변경 사항을 LLM 으로 리뷰"
            >
              👁 {busy === "ai-review" ? "리뷰 중…" : "AI 리뷰"}
            </button>
            <button
              type="button"
              className="wsc-ai-btn"
              disabled={busy !== "idle"}
              onClick={async () => {
                setBusy("ai-msg");
                setStatus(null);
                try {
                  const r = await api.aiCommitMessageWorkspace(workspaceId);
                  setMessage(r.message);
                } catch (e) {
                  setStatus(
                    `AI 커밋 메시지 실패: ${e instanceof Error ? e.message : String(e)}`,
                  );
                } finally {
                  setBusy("idle");
                }
              }}
              title="git diff 를 보고 LLM 이 한국어 커밋 메시지 제안"
            >
              ✨ {busy === "ai-msg" ? "작성 중…" : "AI 커밋 메시지"}
            </button>
          </div>
          <textarea
            className="wsc-msg"
            placeholder="커밋 메시지 (예: Fix XSS in login form)"
            value={message}
            onChange={(ev) => setMessage(ev.target.value)}
            rows={2}
            disabled={busy !== "idle"}
          />

          <div className="wsc-actions">
            <button
              type="button"
              className="wsc-commit-btn"
              onClick={() => doCommit(false)}
              disabled={busy !== "idle"}
            >
              {busy === "committing" ? "커밋 중…" : "커밋"}
            </button>
            <button
              type="button"
              className="wsc-push-btn"
              onClick={() => doCommit(true)}
              disabled={busy !== "idle"}
              title="커밋 후 origin으로 push"
            >
              {busy === "pushing" ? "푸시 중…" : "커밋 + 푸시"}
            </button>
          </div>
        </>
      )}

      {!collapsed && status && (
        <div className={`wsc-status ${statusKind === "err" ? "err" : "ok"}`}>
          {status}
        </div>
      )}

      {diffPath && (
        <DiffView
          workspaceId={workspaceId}
          path={diffPath}
          onClose={() => setDiffPath(null)}
        />
      )}
      {reviewText !== null && (
        <div className="diff-backdrop" onClick={() => setReviewText(null)}>
          <div className="diff-modal" onClick={(ev) => ev.stopPropagation()}>
            <div className="diff-head">
              <strong>👁 AI 코드 리뷰</strong>
              <button type="button" onClick={() => setReviewText(null)}>
                ✕
              </button>
            </div>
            <pre className="wsc-review-body">{reviewText}</pre>
          </div>
        </div>
      )}
    </section>
  );
}
