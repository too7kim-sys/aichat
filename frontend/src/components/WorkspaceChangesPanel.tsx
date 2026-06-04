import { useCallback, useEffect, useState } from "react";
import { api, type WorkspaceStatusEntry } from "../api/client";
import { IconAlertTriangle, IconGitBranch, IconRefresh, IconTrash } from "./Icon";

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
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    api
      .workspaceDiff(workspaceId, path)
      .then((res) => {
        if (!cancelled) setDiff(res.diff || "(변경 없음 — 새 파일이거나 동일한 내용)");
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
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
          <button type="button" onClick={onClose} className="wsc-diff-close">
            닫기
          </button>
        </header>
        {error ? (
          <div className="wsc-diff-error">{error}</div>
        ) : diff === null ? (
          <div className="wsc-diff-loading">diff 로드 중…</div>
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

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"idle" | "committing" | "pushing">("idle");
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<"ok" | "err">("ok");
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
    <section className="wsc-panel">
      <header className="wsc-head">
        <span className="wsc-title">
          <IconGitBranch size={13} /> 변경사항
          {entries.length > 0 && (
            <span className="wsc-count">{entries.length}</span>
          )}
        </span>
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

      {error && (
        <div className="wsc-error">
          <IconAlertTriangle size={12} /> {error}
        </div>
      )}

      {!isGit && !loading && !error && (
        <div className="wsc-empty">
          이 폴더는 git 저장소가 아닙니다.
          <br />
          <small>(LLM 패치 적용은 가능하지만 커밋·푸시는 비활성)</small>
        </div>
      )}

      {isGit && entries.length === 0 && !loading && !error && (
        <div className="wsc-empty">변경된 파일이 없습니다.</div>
      )}

      {entries.length > 0 && (
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

      {status && (
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
    </section>
  );
}
