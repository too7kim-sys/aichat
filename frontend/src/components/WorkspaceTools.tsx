import { Suspense, lazy, useEffect, useState } from "react";
import { api } from "../api/client";
import { errorToast, infoToast } from "../lib/toast";

/** 파일·git 상태가 바뀌면 트리·status 패널이 다시 가져오도록 한 번
 *  쏴 주는 헬퍼.  ws:tree-refresh 를 WorkspaceTree 가 listen. */
function notifyTreeChanged() {
  window.dispatchEvent(new CustomEvent("ws:tree-refresh"));
}

/** 워크스페이스 도구 모음 (#59~64) — 트리 툴바에 6개 버튼 + 각각의
 *  모달.  컴포넌트를 한 파일에 둬 import 줄을 늘리지 않는다. */

// ── #59 브랜치 관리 ─────────────────────────────────────────
export function BranchPanel({
  workspaceId,
  onChanged,
}: {
  workspaceId: string;
  onChanged?: () => void;
}) {
  type Data = Awaited<ReturnType<typeof api.workspaceBranches>>;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");

  async function refresh() {
    try {
      setData(await api.workspaceBranches(workspaceId));
    } catch {
      setData(null);
    }
  }
  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, workspaceId]);

  async function switchTo(name: string, create = false) {
    setBusy(true);
    try {
      await api.workspaceSwitchBranch(workspaceId, name, create);
      notifyTreeChanged();
      onChanged?.();
      await refresh();
    } catch (e) {
      errorToast("전환 실패", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="ws-tree-btn"
        onClick={() => setOpen(true)}
        title="git 브랜치 관리"
      >
        🌿 브랜치
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>🌿 브랜치 관리</h3>
              {data && <code className="patch-preview-path">현재: {data.current || "(detached)"}</code>}
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              <div className="ws-branch-new">
                <input
                  placeholder="새 브랜치 이름"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  disabled={busy}
                />
                <button
                  type="button"
                  disabled={busy || !newName.trim()}
                  onClick={() => switchTo(newName.trim(), true)}
                >
                  + 생성·전환
                </button>
              </div>
              {!data ? (
                <div className="patch-preview-empty">불러오는 중…</div>
              ) : (
                <>
                  <div className="ws-branch-sec">로컬</div>
                  <ul className="ws-branch-list">
                    {data.local.map((b) => (
                      <li key={`L-${b}`}>
                        <span>{b}</span>
                        <button
                          type="button"
                          disabled={busy || b === data.current}
                          onClick={() => switchTo(b)}
                        >
                          {b === data.current ? "현재" : "전환"}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {data.remote.length > 0 && (
                    <>
                      <div className="ws-branch-sec">원격</div>
                      <ul className="ws-branch-list">
                        {data.remote.map((b) => (
                          <li key={`R-${b}`}>
                            <span>{b}</span>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                const local = b.replace(/^[^/]+\//, "");
                                switchTo(local, true);
                              }}
                            >
                              체크아웃
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #60 git log 뷰어 ───────────────────────────────────────
export function LogPanel({ workspaceId }: { workspaceId: string }) {
  type LogData = Awaited<ReturnType<typeof api.workspaceLog>>;
  type FilesData = Awaited<ReturnType<typeof api.workspaceCommitFiles>>;
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<LogData | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [files, setFiles] = useState<FilesData | null>(null);
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    api.workspaceLog(workspaceId, 80).then(setLog).catch(() => setLog(null));
  }, [open, workspaceId]);
  useEffect(() => {
    if (!sel) {
      setFiles(null);
      return;
    }
    api.workspaceCommitFiles(workspaceId, sel).then(setFiles).catch(() => setFiles(null));
  }, [sel, workspaceId]);

  async function showFileDiff(path: string) {
    if (!sel) return;
    setDiff({ path, text: "(로드 중…)" });
    try {
      const r = await api.workspaceCommitFileDiff(workspaceId, sel, path);
      setDiff({ path, text: r.diff });
    } catch (e) {
      setDiff({ path, text: `(로드 실패: ${e instanceof Error ? e.message : String(e)})` });
    }
  }

  return (
    <>
      <button
        type="button"
        className="ws-tree-btn"
        onClick={() => setOpen(true)}
        title="git log — 최근 커밋"
      >
        📜 로그
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal ws-log-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>📜 git log</h3>
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="ws-log-body">
              <div className="ws-log-left">
                {!log ? (
                  <div className="patch-preview-empty">불러오는 중…</div>
                ) : (
                  <ul className="ws-log-list">
                    {log.commits.map((c) => (
                      <li
                        key={c.sha}
                        className={sel === c.sha ? "active" : ""}
                        onClick={() => setSel(c.sha)}
                      >
                        <code>{c.short_sha}</code>
                        <span className="ws-log-subj">{c.subject}</span>
                        <span className="ws-log-meta">
                          {c.author_name} · {new Date(c.when).toLocaleDateString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="ws-log-right">
                {sel ? (
                  files ? (
                    <ul className="ws-log-files">
                      {files.files.map((f) => (
                        <li
                          key={`${sel}-${f.path}`}
                          onClick={() => showFileDiff(f.path)}
                        >
                          <span className={`ws-log-status st-${f.status}`}>{f.status}</span>
                          <span>{f.path}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="patch-preview-empty">파일 목록 로드 중…</div>
                  )
                ) : (
                  <div className="patch-preview-empty">왼쪽에서 커밋을 선택하세요.</div>
                )}
              </div>
            </div>
            {diff && (
              <div className="ws-log-diff">
                <header>
                  <code>{diff.path}</code>
                  <button type="button" onClick={() => setDiff(null)}>닫기</button>
                </header>
                <pre>{diff.text}</pre>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ── #61 파일 CRUD (트리 위쪽 새 파일/폴더 + 우클릭 메뉴 대안) ─
export function FileCRUDPanel({
  workspaceId,
  onChanged,
}: {
  workspaceId: string;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState("");
  const [kind, setKind] = useState<"file" | "dir">("file");

  async function doCreate() {
    if (!path.trim()) return;
    setBusy(true);
    try {
      await api.workspaceCreatePath(workspaceId, path.trim(), kind);
      notifyTreeChanged();
      onChanged?.();
      setPath("");
      setOpen(false);
    } catch (e) {
      errorToast("생성 실패", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="ws-tree-btn"
        onClick={() => setOpen(true)}
        title="새 파일 / 폴더"
      >
        ➕ 새로
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>➕ 새로 만들기</h3>
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              <div className="ws-crud-row">
                <select value={kind} onChange={(e) => setKind(e.target.value as "file" | "dir")}>
                  <option value="file">파일</option>
                  <option value="dir">폴더</option>
                </select>
                <input
                  placeholder="경로 예: src/utils/foo.ts"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") doCreate();
                  }}
                  autoFocus
                />
                <button type="button" onClick={doCreate} disabled={busy || !path.trim()}>
                  {busy ? "…" : "만들기"}
                </button>
              </div>
              <p className="ws-crud-hint">
                상대 경로만 허용 (.., 절대 경로 불가).  부모 폴더가 없으면 자동 생성.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #62 find & replace ─────────────────────────────────────
export function ReplacePanel({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [r, setR] = useState("");
  const [regex, setRegex] = useState(false);
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof api.workspaceReplace>
  > | null>(null);

  async function run(dryRun: boolean) {
    if (!q.trim() || q.trim().length < 2) return;
    if (!dryRun) {
      if (
        !window.confirm(
          `정말 ${preview?.total_replacements ?? "?"}곳을 일괄 치환할까요? 되돌리려면 git checkout 을 사용해야 해요.`,
        )
      )
        return;
    }
    setBusy(true);
    try {
      const res = await api.workspaceReplace(workspaceId, {
        query: q.trim(),
        replacement: r,
        regex,
        dryRun,
      });
      setPreview(res);
      if (!dryRun) notifyTreeChanged();
    } catch (e) {
      errorToast("치환 실패", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title="다중 파일 치환">
        🔁 치환
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>🔁 다중 파일 치환</h3>
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              <div className="ws-crud-row">
                <input
                  placeholder="찾을 텍스트 (2자 이상)"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              <div className="ws-crud-row">
                <input
                  placeholder="바꿀 텍스트 (빈 값 = 삭제)"
                  value={r}
                  onChange={(e) => setR(e.target.value)}
                />
              </div>
              <div className="ws-crud-row">
                <label className="ws-grep-toggle">
                  <input
                    type="checkbox"
                    checked={regex}
                    onChange={(e) => setRegex(e.target.checked)}
                  />
                  regex
                </label>
                <button type="button" disabled={busy || q.trim().length < 2} onClick={() => run(true)}>
                  미리보기
                </button>
                <button
                  type="button"
                  disabled={busy || !preview || preview.total_replacements === 0}
                  onClick={() => run(false)}
                  className="primary"
                >
                  적용 ({preview?.total_replacements ?? 0}곳)
                </button>
              </div>
              {preview && (
                <ul className="ws-replace-list">
                  {preview.files.length === 0 ? (
                    <li className="patch-preview-empty">매칭 없음</li>
                  ) : (
                    preview.files.map((f) => (
                      <li key={f.path}>
                        <code>{f.path}</code>
                        <span>{f.count}곳</span>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #63 TODO / FIXME ──────────────────────────────────────
export function TodoPanel({
  workspaceId,
  onJump,
}: {
  workspaceId: string;
  onJump: (path: string) => void;
}) {
  type Data = Awaited<ReturnType<typeof api.workspaceTodos>>;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [filter, setFilter] = useState<string>("ALL");

  useEffect(() => {
    if (!open) return;
    api.workspaceTodos(workspaceId).then(setData).catch(() => setData(null));
  }, [open, workspaceId]);

  const items = data?.items.filter((i) => filter === "ALL" || i.tag === filter) ?? [];

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title="TODO/FIXME/HACK 모음">
        ✅ TODO
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>✅ TODO / FIXME / HACK</h3>
              {data && <code className="patch-preview-path">{data.count}건</code>}
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              <div className="ws-crud-row">
                {["ALL", "TODO", "FIXME", "HACK", "XXX", "BUG", "NOTE"].map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`ws-tree-btn${filter === t ? " primary" : ""}`}
                    onClick={() => setFilter(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
              {!data ? (
                <div className="patch-preview-empty">불러오는 중…</div>
              ) : items.length === 0 ? (
                <div className="patch-preview-empty">✓ 매칭 항목 없음</div>
              ) : (
                <ul className="ws-todo-list">
                  {items.map((it, i) => (
                    <li key={`${it.path}:${it.line}:${i}`}>
                      <button
                        type="button"
                        onClick={() => {
                          onJump(it.path);
                          setOpen(false);
                        }}
                      >
                        <span className={`ws-todo-tag tag-${it.tag}`}>{it.tag}</span>
                        <code>{it.path}:{it.line}</code>
                        <span className="ws-todo-msg">{it.message}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #64 워크스페이스 통계 ──────────────────────────────────
export function StatsPanel({ workspaceId }: { workspaceId: string }) {
  type Data = Awaited<ReturnType<typeof api.workspaceStats>>;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    if (!open) return;
    api.workspaceStats(workspaceId).then(setData).catch(() => setData(null));
  }, [open, workspaceId]);

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title="LOC · 언어 분포 · 가장 큰 파일">
        📊 통계
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>📊 워크스페이스 통계</h3>
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              {!data ? (
                <div className="patch-preview-empty">집계 중…</div>
              ) : (
                <>
                  <div className="ws-stats-top">
                    <div><b>{data.file_count.toLocaleString()}</b><span>파일</span></div>
                    <div><b>{data.total_loc.toLocaleString()}</b><span>LOC</span></div>
                    <div><b>{(data.total_bytes / 1024 / 1024).toFixed(1)} MB</b><span>총 크기</span></div>
                  </div>
                  <div className="ws-stats-sec">언어 분포</div>
                  <table className="ws-stats-table">
                    <thead><tr><th>언어</th><th>파일</th><th>LOC</th><th>%</th></tr></thead>
                    <tbody>
                      {data.languages.map((l) => {
                        const pct = data.total_loc ? (l.loc / data.total_loc) * 100 : 0;
                        return (
                          <tr key={l.lang}>
                            <td><code>{l.lang}</code></td>
                            <td>{l.files}</td>
                            <td>{l.loc.toLocaleString()}</td>
                            <td>
                              <div className="ws-stats-bar">
                                <div style={{ width: `${pct}%` }} />
                                <span>{pct.toFixed(1)}%</span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div className="ws-stats-sec">가장 큰 파일</div>
                  <ul className="ws-stats-biggest">
                    {data.biggest_files.map((f) => (
                      <li key={f.path}>
                        <code>{f.path}</code>
                        <span>{(f.size / 1024).toFixed(1)} KB</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}


// ── #65 스태시 관리 ───────────────────────────────────────
export function StashPanel({
  workspaceId,
  onChanged,
}: {
  workspaceId: string;
  onChanged?: () => void;
}) {
  type Data = Awaited<ReturnType<typeof api.workspaceStashes>>;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function refresh() {
    try {
      setData(await api.workspaceStashes(workspaceId));
    } catch {
      setData(null);
    }
  }
  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, workspaceId]);

  async function save() {
    setBusy(true);
    try {
      await api.workspaceStashSave(workspaceId, msg);
      setMsg("");
      notifyTreeChanged();
      onChanged?.();
      await refresh();
    } catch (e) {
      errorToast("스태시 실패", e);
    } finally {
      setBusy(false);
    }
  }
  async function apply(ref: string, pop: boolean) {
    setBusy(true);
    try {
      await api.workspaceStashApply(workspaceId, ref, pop);
      notifyTreeChanged();
      onChanged?.();
      await refresh();
    } catch (e) {
      errorToast("적용 실패", e);
    } finally {
      setBusy(false);
    }
  }
  async function drop(ref: string) {
    if (!window.confirm(`${ref} 를 삭제할까요?  되돌릴 수 없어요.`)) return;
    setBusy(true);
    try {
      await api.workspaceStashDrop(workspaceId, ref);
      await refresh();
    } catch (e) {
      errorToast("삭제 실패", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title="git stash 관리">
        📥 스태시
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>📥 스태시 관리</h3>
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              <div className="ws-crud-row">
                <input
                  placeholder="새 스태시 메시지 (선택)"
                  value={msg}
                  onChange={(e) => setMsg(e.target.value)}
                  disabled={busy}
                />
                <button type="button" onClick={save} disabled={busy}>
                  {busy ? "…" : "+ 현재 변경 stash"}
                </button>
              </div>
              {!data ? (
                <div className="patch-preview-empty">불러오는 중…</div>
              ) : data.stashes.length === 0 ? (
                <div className="patch-preview-empty">저장된 스태시가 없어요.</div>
              ) : (
                <ul className="ws-branch-list">
                  {data.stashes.map((s) => (
                    <li key={s.index}>
                      <span title={s.when}>
                        <code>{s.index}</code> · {s.message}
                      </span>
                      <span style={{ display: "inline-flex", gap: 4 }}>
                        <button type="button" disabled={busy} onClick={() => apply(s.index, true)} title="apply + drop">
                          pop
                        </button>
                        <button type="button" disabled={busy} onClick={() => apply(s.index, false)}>
                          apply
                        </button>
                        <button type="button" disabled={busy} onClick={() => drop(s.index)}>
                          drop
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #66 conflict 해결 (3-way Monaco DiffEditor) ───────────
const ConflictDiffEditor = lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.DiffEditor })),
);
const ConflictMonacoEditor = lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.default })),
);

export function ConflictPanel({
  workspaceId,
  onChanged,
}: {
  workspaceId: string;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [data, setData] = useState<{
    base: string;
    ours: string;
    theirs: string;
    merged: string;
  } | null>(null);
  const [edit, setEdit] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.workspaceConflicts(workspaceId).then((r) => setPaths(r.paths)).catch(() => setPaths([]));
  }, [open, workspaceId]);
  useEffect(() => {
    if (!sel) {
      setData(null);
      return;
    }
    api
      .workspaceConflictVersions(workspaceId, sel)
      .then((r) => {
        setData(r);
        setEdit(r.merged);
      })
      .catch(() => setData(null));
  }, [sel, workspaceId]);

  async function resolve() {
    if (!sel) return;
    setBusy(true);
    try {
      await api.workspaceConflictResolve(workspaceId, sel, edit);
      notifyTreeChanged();
      onChanged?.();
      // refresh.
      const r = await api.workspaceConflicts(workspaceId);
      setPaths(r.paths);
      setSel(null);
      setData(null);
    } catch (e) {
      errorToast("해결 실패", e);
    } finally {
      setBusy(false);
    }
  }

  // 충돌이 없으면 버튼 자체를 숨김 — UI 가 너무 복잡해지지 않게.
  // 사용자가 메뉴 열어도 깔끔.
  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title="머지 conflict 해결">
        ⚔ conflict
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal ws-log-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>⚔ 머지 conflict</h3>
              {sel && <code className="patch-preview-path">{sel}</code>}
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              {!sel ? (
                paths.length === 0 ? (
                  <div className="patch-preview-empty">✓ conflict 파일 없음</div>
                ) : (
                  <ul className="ws-branch-list">
                    {paths.map((p) => (
                      <li key={p}>
                        <span><code>{p}</code></span>
                        <button type="button" onClick={() => setSel(p)}>
                          해결
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              ) : !data ? (
                <div className="patch-preview-empty">불러오는 중…</div>
              ) : (
                <>
                  <div className="ws-crud-row">
                    <button type="button" onClick={() => setEdit(data.ours)}>
                      ⬅ 내 변경 사용
                    </button>
                    <button type="button" onClick={() => setEdit(data.theirs)}>
                      상대 변경 사용 ➡
                    </button>
                    <button type="button" onClick={() => setEdit(data.base)}>
                      공통 조상으로
                    </button>
                  </div>
                  <div className="ws-conflict-grid">
                    <div>
                      <div className="ws-conflict-label">내 변경 (ours)</div>
                      <Suspense fallback={<div className="patch-preview-empty">…</div>}>
                        <ConflictDiffEditor
                          height="34vh"
                          original={data.base}
                          modified={data.ours}
                          theme={
                            document.documentElement.getAttribute("data-theme") === "dark"
                              ? "vs-dark"
                              : "light"
                          }
                          options={{ readOnly: true, renderSideBySide: false, minimap: { enabled: false }, automaticLayout: true }}
                        />
                      </Suspense>
                    </div>
                    <div>
                      <div className="ws-conflict-label">상대 변경 (theirs)</div>
                      <Suspense fallback={<div className="patch-preview-empty">…</div>}>
                        <ConflictDiffEditor
                          height="34vh"
                          original={data.base}
                          modified={data.theirs}
                          theme={
                            document.documentElement.getAttribute("data-theme") === "dark"
                              ? "vs-dark"
                              : "light"
                          }
                          options={{ readOnly: true, renderSideBySide: false, minimap: { enabled: false }, automaticLayout: true }}
                        />
                      </Suspense>
                    </div>
                  </div>
                  <div className="ws-conflict-label">최종 결과 (편집 후 저장)</div>
                  <Suspense fallback={<div className="patch-preview-empty">에디터 로딩…</div>}>
                    <div className="ws-conflict-merge">
                      <ConflictMonacoEditor
                        height="34vh"
                        value={edit}
                        theme={
                          document.documentElement.getAttribute("data-theme") === "dark"
                            ? "vs-dark"
                            : "light"
                        }
                        onChange={(v) => setEdit(v || "")}
                        options={{ minimap: { enabled: false }, automaticLayout: true, wordWrap: "on" }}
                      />
                    </div>
                  </Suspense>
                  <div className="ws-crud-row">
                    <button type="button" onClick={() => setSel(null)}>← 목록</button>
                    <button type="button" className="primary" disabled={busy} onClick={resolve}>
                      {busy ? "…" : "✓ 저장 + git add"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #67 사용자 정의 task ──────────────────────────────────
export function CustomTasksPanel({ workspaceId }: { workspaceId: string }) {
  type Tasks = Awaited<ReturnType<typeof api.workspaceCustomTasks>>;
  type Result = Awaited<ReturnType<typeof api.workspaceCustomTaskRun>>;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Tasks | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!open) return;
    api.workspaceCustomTasks(workspaceId).then(setData).catch(() => setData(null));
  }, [open, workspaceId]);

  async function run(id: string) {
    setRunning(id);
    setResult(null);
    try {
      const r = await api.workspaceCustomTaskRun(workspaceId, id);
      setResult(r);
    } catch (e) {
      errorToast("실행 실패", e);
    } finally {
      setRunning(null);
    }
  }

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title=".aichat-tasks.json 사용자 명령">
        ⚙ tasks
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>⚙ 사용자 정의 task</h3>
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              <p className="ws-crud-hint">
                워크스페이스 루트의 <code>.aichat-tasks.json</code> 을 읽어 등록된 명령을 안전하게 실행합니다.
                예: <code>{`{"tasks": [{"name": "통합 빌드", "argv": ["make", "all"], "timeout": 120}]}`}</code>
              </p>
              {!data ? (
                <div className="patch-preview-empty">불러오는 중…</div>
              ) : data.tasks.length === 0 ? (
                <div className="patch-preview-empty">.aichat-tasks.json 이 없거나 비어 있어요.</div>
              ) : (
                <ul className="ws-branch-list">
                  {data.tasks.map((t) => (
                    <li key={t.id}>
                      <span>
                        <b>{t.name}</b>
                        {t.description && <em style={{ marginLeft: 8, color: "var(--text-muted)" }}>· {t.description}</em>}
                      </span>
                      <button type="button" disabled={running === t.id} onClick={() => run(t.id)}>
                        {running === t.id ? "…" : "▶ 실행"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {result && (
                <>
                  <div className="ws-stats-sec">
                    {result.name} · {result.ok ? "✅ ok" : "❌ fail"} · {result.duration_ms}ms
                  </div>
                  {result.stdout && (
                    <>
                      <div className="patch-preview-meta">STDOUT</div>
                      <pre className="patch-preview-diff">{result.stdout}</pre>
                    </>
                  )}
                  {result.stderr && (
                    <>
                      <div className="patch-preview-meta">STDERR</div>
                      <pre className="patch-preview-diff">{result.stderr}</pre>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #68 AI 리팩터 / 테스트 생성 ───────────────────────────
export function AIToolsPanel({
  workspaceId,
  filePath,
}: {
  workspaceId: string;
  filePath: string | null;
}) {
  const [open, setOpen] = useState<"refactor" | "tests" | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");

  async function run(kind: "refactor" | "tests") {
    if (!filePath) {
      infoToast("먼저 트리에서 파일을 선택하세요.");
      return;
    }
    setOpen(kind);
    setBusy(true);
    setText("(생성 중…)");
    try {
      if (kind === "refactor") {
        const r = await api.workspaceAiRefactor(workspaceId, filePath);
        setText(r.review);
      } else {
        const r = await api.workspaceAiTests(workspaceId, filePath);
        setText(r.tests);
      }
    } catch (e) {
      setText(`실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => run("refactor")} title="선택한 파일을 AI 가 리팩터 제안" disabled={busy || !filePath}>
        🤖 리팩터
      </button>
      <button type="button" className="ws-tree-btn" onClick={() => run("tests")} title="선택한 파일에 대한 단위 테스트 생성" disabled={busy || !filePath}>
        🧪 AI 테스트
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(null)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>{open === "refactor" ? "🤖 AI 리팩터 제안" : "🧪 AI 테스트 생성"}</h3>
              {filePath && <code className="patch-preview-path">{filePath}</code>}
              <button type="button" className="modal-close" onClick={() => setOpen(null)}>×</button>
            </header>
            <pre className="wsc-review-body">{text}</pre>
          </div>
        </div>
      )}
    </>
  );
}

// ── #70 파일 활동 타임라인 ────────────────────────────────
export function TimelinePanel({
  workspaceId,
  filePath,
}: {
  workspaceId: string;
  filePath: string | null;
}) {
  type Data = Awaited<ReturnType<typeof api.workspaceFileTimeline>>;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    if (!open || !filePath) {
      setData(null);
      return;
    }
    api.workspaceFileTimeline(workspaceId, filePath, 80).then(setData).catch(() => setData(null));
  }, [open, workspaceId, filePath]);

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title="선택 파일의 git log + 채팅 흔적" disabled={!filePath}>
        ⏱ 활동
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>⏱ 파일 활동 타임라인</h3>
              {filePath && <code className="patch-preview-path">{filePath}</code>}
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              {!filePath ? (
                <div className="patch-preview-empty">먼저 트리에서 파일을 선택하세요.</div>
              ) : !data ? (
                <div className="patch-preview-empty">불러오는 중…</div>
              ) : (
                <>
                  <div className="ws-stats-sec">git 커밋 ({data.commits.length})</div>
                  {data.commits.length === 0 ? (
                    <div className="patch-preview-empty">변경 이력 없음</div>
                  ) : (
                    <ul className="ws-log-list">
                      {data.commits.map((c) => (
                        <li key={c.sha}>
                          <code>{c.short_sha}</code>
                          <span className="ws-log-subj">{c.subject}</span>
                          <span className="ws-log-meta">
                            {c.author_name} · {new Date(c.when).toLocaleDateString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="ws-stats-sec">채팅에서 언급 ({data.chats.length})</div>
                  {data.chats.length === 0 ? (
                    <div className="patch-preview-empty">언급된 메시지 없음</div>
                  ) : (
                    <ul className="ws-todo-list">
                      {data.chats.map((m) => (
                        <li key={m.message_id}>
                          <button
                            type="button"
                            onClick={() => {
                              window.dispatchEvent(
                                new CustomEvent("chat:switch-session", {
                                  detail: {
                                    sessionId: m.session_id,
                                    messageId: m.message_id,
                                  },
                                }),
                              );
                              setOpen(false);
                            }}
                          >
                            <span className={`ws-todo-tag tag-${m.role === "user" ? "NOTE" : "TODO"}`}>
                              {m.role === "user" ? "USER" : "AI"}
                            </span>
                            <code>{m.when ? new Date(m.when).toLocaleString() : ""}</code>
                            <span className="ws-todo-msg">{m.snippet}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}


// ── #71 코드 스니펫 라이브러리 ─────────────────────────────
export function SnippetPanel({
  onInsert,
  isAdmin,
}: {
  onInsert: (text: string) => void;
  isAdmin: boolean;
}) {
  type Snip = Awaited<ReturnType<typeof api.listSnippets>>[number];
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Snip[]>([]);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [lang, setLang] = useState("");
  const [scope, setScope] = useState<"personal" | "team">("personal");

  async function refresh() {
    try {
      setList(await api.listSnippets());
    } catch {
      setList([]);
    }
  }
  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open]);

  async function save() {
    if (!name.trim() || !body.trim()) return;
    try {
      await api.createSnippet({
        name: name.trim(),
        body,
        language: lang.trim(),
        scope,
      });
      setName("");
      setBody("");
      setLang("");
      setAdding(false);
      await refresh();
    } catch (e) {
      errorToast("저장 실패", e);
    }
  }
  async function remove(id: string) {
    if (!window.confirm("이 스니펫을 삭제할까요?")) return;
    try {
      await api.deleteSnippet(id);
      await refresh();
    } catch (e) {
      errorToast("삭제 실패", e);
    }
  }

  const filtered = q.trim()
    ? list.filter(
        (s) =>
          s.name.toLowerCase().includes(q.toLowerCase()) ||
          s.body.toLowerCase().includes(q.toLowerCase()),
      )
    : list;

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title="코드 스니펫 라이브러리">
        ✂ 스니펫
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>✂ 코드 스니펫</h3>
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              <div className="ws-crud-row">
                <input
                  className="ws-grep-input"
                  placeholder="검색"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
                <button type="button" onClick={() => setAdding((v) => !v)}>
                  {adding ? "취소" : "+ 추가"}
                </button>
              </div>
              {adding && (
                <div className="ws-snippet-form">
                  <input placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
                  <input placeholder="언어 (python, typescript…)" value={lang} onChange={(e) => setLang(e.target.value)} maxLength={40} />
                  <select value={scope} onChange={(e) => setScope(e.target.value as "personal" | "team")} disabled={!isAdmin}>
                    <option value="personal">개인</option>
                    {isAdmin && <option value="team">팀 공유</option>}
                  </select>
                  <textarea
                    placeholder="스니펫 본문 (코드)"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    rows={6}
                  />
                  <button type="button" className="primary" onClick={save} disabled={!name.trim() || !body.trim()}>
                    저장
                  </button>
                </div>
              )}
              {filtered.length === 0 ? (
                <div className="patch-preview-empty">스니펫이 없어요.</div>
              ) : (
                <ul className="ws-snippet-list">
                  {filtered.map((s) => (
                    <li key={s.id}>
                      <div className="ws-snippet-head">
                        <span>
                          <b>{s.name}</b>
                          <span className={`ws-todo-tag tag-${s.scope === "team" ? "TODO" : "NOTE"}`} style={{ marginLeft: 8 }}>
                            {s.scope === "team" ? "팀" : "개인"}
                          </span>
                          {s.language && <em style={{ marginLeft: 8, color: "var(--text-muted)" }}>{s.language}</em>}
                        </span>
                        <span>
                          <button type="button" onClick={() => { onInsert(s.body); setOpen(false); }}>
                            삽입
                          </button>
                          {(s.owned || (s.scope === "team" && isAdmin)) && (
                            <button type="button" onClick={() => remove(s.id)} style={{ marginLeft: 4 }}>
                              ×
                            </button>
                          )}
                        </span>
                      </div>
                      <pre className="ws-snippet-body">{s.body.slice(0, 320)}{s.body.length > 320 ? "…" : ""}</pre>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #72 AI 문서화 — AIToolsPanel 옵션 확장 대신 별 버튼 ─────
export function AIDocPanel({
  workspaceId,
  filePath,
}: {
  workspaceId: string;
  filePath: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");

  async function run() {
    if (!filePath) {
      infoToast("먼저 트리에서 파일을 선택하세요.");
      return;
    }
    setOpen(true);
    setBusy(true);
    setText("(생성 중…)");
    try {
      const r = await api.workspaceAiDocument(workspaceId, filePath);
      setText(r.documented);
    } catch (e) {
      setText(`실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={run} disabled={busy || !filePath} title="선택 파일에 한국어 docstring 추가">
        📖 문서화
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>📖 AI 문서화</h3>
              {filePath && <code className="patch-preview-path">{filePath}</code>}
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <pre className="wsc-review-body">{text}</pre>
          </div>
        </div>
      )}
    </>
  );
}

// ── #74 AI 보안 점검 ──────────────────────────────────────
export function SecurityPanel({
  workspaceId,
  onJump,
}: {
  workspaceId: string;
  onJump: (path: string) => void;
}) {
  type Data = Awaited<ReturnType<typeof api.workspaceSecurityScan>>;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setOpen(true);
    setBusy(true);
    setData(null);
    try {
      setData(await api.workspaceSecurityScan(workspaceId));
    } catch (e) {
      errorToast("보안 점검 실패", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={run} title="정적 패턴 + LLM 보안 점검" disabled={busy}>
        🛡 {busy ? "점검…" : "보안"}
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>🛡 AI 보안 점검</h3>
              {data && <code className="patch-preview-path">{data.count}건 검출</code>}
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              {!data ? (
                <div className="patch-preview-empty">점검 중…</div>
              ) : (
                <>
                  <div className="ws-stats-sec">LLM 요약</div>
                  <pre className="wsc-review-body">{data.summary}</pre>
                  <div className="ws-stats-sec">검출 항목 ({data.findings.length})</div>
                  {data.findings.length === 0 ? (
                    <div className="patch-preview-empty">✓ 패턴 검출 없음</div>
                  ) : (
                    <ul className="ws-todo-list">
                      {data.findings.map((f, i) => (
                        <li key={`${f.path}:${f.line}:${i}`}>
                          <button
                            type="button"
                            onClick={() => {
                              onJump(f.path);
                              setOpen(false);
                            }}
                          >
                            <span className="ws-todo-tag tag-FIXME">SEC</span>
                            <code>{f.path}:{f.line}</code>
                            <span className="ws-todo-msg">
                              <b>{f.label}</b>  · {f.snippet}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #75 git tag 관리 ──────────────────────────────────────
export function TagPanel({ workspaceId }: { workspaceId: string }) {
  type Data = Awaited<ReturnType<typeof api.workspaceTags>>;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setData(await api.workspaceTags(workspaceId));
    } catch {
      setData(null);
    }
  }
  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open]);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.workspaceTagCreate(workspaceId, name.trim(), msg);
      setName("");
      setMsg("");
      notifyTreeChanged();
      await refresh();
    } catch (e) {
      errorToast("태그 실패", e);
    } finally {
      setBusy(false);
    }
  }
  async function push(n: string) {
    setBusy(true);
    try {
      await api.workspaceTagPush(workspaceId, n);
      infoToast(`pushed: ${n}`);
    } catch (e) {
      errorToast("push 실패", e);
    } finally {
      setBusy(false);
    }
  }
  async function del(n: string) {
    if (!window.confirm(`${n} 태그를 삭제할까요?`)) return;
    setBusy(true);
    try {
      await api.workspaceTagDelete(workspaceId, n);
      notifyTreeChanged();
      await refresh();
    } catch (e) {
      errorToast("삭제 실패", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title="git tag 관리">
        🏷 태그
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>🏷 git 태그 / 릴리즈</h3>
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              <div className="ws-crud-row">
                <input placeholder="새 태그 이름 (예: v1.2.0)" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
                <input placeholder="메시지 (선택, annotated 태그)" value={msg} onChange={(e) => setMsg(e.target.value)} disabled={busy} />
                <button type="button" disabled={busy || !name.trim()} onClick={create}>
                  + 생성
                </button>
              </div>
              {!data ? (
                <div className="patch-preview-empty">불러오는 중…</div>
              ) : data.tags.length === 0 ? (
                <div className="patch-preview-empty">태그가 없어요.</div>
              ) : (
                <ul className="ws-branch-list">
                  {data.tags.map((t) => (
                    <li key={t.name}>
                      <span>
                        <b>{t.name}</b>
                        <code style={{ marginLeft: 8 }}>{t.sha}</code>
                        <em style={{ marginLeft: 8, color: "var(--text-muted)" }}>{t.subject}</em>
                      </span>
                      <span style={{ display: "inline-flex", gap: 4 }}>
                        <button type="button" disabled={busy} onClick={() => push(t.name)}>push</button>
                        <button type="button" disabled={busy} onClick={() => del(t.name)}>×</button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #76 의존성 dashboard ──────────────────────────────────
export function DependenciesPanel({ workspaceId }: { workspaceId: string }) {
  type Data = Awaited<ReturnType<typeof api.workspaceDependencies>>;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    if (!open) return;
    api.workspaceDependencies(workspaceId).then(setData).catch(() => setData(null));
  }, [open, workspaceId]);

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title="의존성 manifest 파싱">
        📦 의존성
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>📦 의존성 dashboard</h3>
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              {!data ? (
                <div className="patch-preview-empty">불러오는 중…</div>
              ) : Object.keys(data.managers).length === 0 ? (
                <div className="patch-preview-empty">manifest 파일이 없어요 (package.json / requirements.txt / pyproject.toml / Cargo.toml / go.mod).</div>
              ) : (
                Object.entries(data.managers).map(([mgr, deps]) => (
                  <div key={mgr}>
                    <div className="ws-stats-sec">
                      {mgr} <em style={{ color: "var(--text-muted)" }}>· {deps.length}개</em>
                    </div>
                    <table className="ws-stats-table">
                      <thead>
                        <tr>
                          <th>패키지</th>
                          <th>버전</th>
                          <th>구분</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deps.map((d, i) => (
                          <tr key={`${mgr}-${d.name}-${i}`}>
                            <td><code>{d.name}</code></td>
                            <td>{d.version || "—"}</td>
                            <td>{d.type}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #73 최근 본 파일 / 즐겨찾기 — localStorage 기반 클라이언트 사이드 ──
const RECENT_KEY = (wid: string) => `ws:${wid}:recent`;
const PIN_KEY = (wid: string) => `ws:${wid}:pinned`;

function readArr(k: string): string[] {
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function writeArr(k: string, arr: string[]) {
  try {
    localStorage.setItem(k, JSON.stringify(arr.slice(0, 50)));
  } catch {
    /* full / private */
  }
}

/** 트리 상단 작은 박스 — 즐겨찾기 + 최근 본 파일.  WorkspaceTree 가
 *  파일을 열 때 record() 를 호출해 LS 에 push, 컴포넌트가 그걸 다시
 *  읽어 보여준다.  ★ 클릭 = 핀 토글. */
export function RecentFilesPanel({
  workspaceId,
  onSelect,
  bumpKey,
}: {
  workspaceId: string;
  onSelect: (path: string) => void;
  /** 부모가 파일을 열 때마다 증가시키면 리스트 다시 읽음. */
  bumpKey: number;
}) {
  const [recent, setRecent] = useState<string[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  useEffect(() => {
    setRecent(readArr(RECENT_KEY(workspaceId)));
    setPinned(readArr(PIN_KEY(workspaceId)));
  }, [workspaceId, bumpKey]);

  function togglePin(p: string) {
    const next = pinned.includes(p)
      ? pinned.filter((x) => x !== p)
      : [p, ...pinned];
    setPinned(next);
    writeArr(PIN_KEY(workspaceId), next);
  }
  function clear() {
    if (!window.confirm("최근 본 파일 기록을 모두 지울까요?")) return;
    setRecent([]);
    writeArr(RECENT_KEY(workspaceId), []);
  }

  const shown = [
    ...pinned.map((p) => ({ p, pin: true })),
    ...recent.filter((p) => !pinned.includes(p)).slice(0, 8).map((p) => ({ p, pin: false })),
  ];
  if (shown.length === 0) return null;

  return (
    <div className="ws-recent">
      <div className="ws-recent-head">
        <span>⭐ 즐겨찾기 / 최근</span>
        <button type="button" onClick={clear}>지우기</button>
      </div>
      <ul>
        {shown.map(({ p, pin }) => (
          <li key={p}>
            <button type="button" onClick={() => togglePin(p)} title={pin ? "고정 해제" : "고정"}>
              {pin ? "★" : "☆"}
            </button>
            <button type="button" onClick={() => onSelect(p)}>
              <code>{p}</code>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 외부에서 파일을 열었을 때 호출 — 최근 목록에 push. */
export function recordRecentFile(workspaceId: string, path: string) {
  if (!path) return;
  const cur = readArr(RECENT_KEY(workspaceId));
  const next = [path, ...cur.filter((x) => x !== path)];
  writeArr(RECENT_KEY(workspaceId), next);
}


// ── #77 체리픽 + 리셋 ─────────────────────────────────────
export function CherryResetPanel({
  workspaceId,
  onChanged,
}: {
  workspaceId: string;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"cherry" | "reset">("cherry");
  const [sha, setSha] = useState("");
  const [mode, setMode] = useState<"soft" | "mixed" | "hard">("soft");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string | null>(null);

  async function doCherryPick() {
    if (!sha.trim()) return;
    setBusy(true);
    setOut(null);
    try {
      const r = await api.workspaceCherryPick(workspaceId, sha.trim());
      setOut(r.stdout || "(완료)");
      notifyTreeChanged();
      onChanged?.();
    } catch (e) {
      setOut(`실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }
  async function doReset() {
    if (!sha.trim()) return;
    if (mode === "hard") {
      if (!window.confirm("hard reset 은 working tree 변경 사항도 모두 날립니다.  계속할까요?"))
        return;
    }
    setBusy(true);
    setOut(null);
    try {
      const r = await api.workspaceReset(workspaceId, sha.trim(), mode);
      setOut(r.stdout || "(완료)");
      notifyTreeChanged();
      onChanged?.();
    } catch (e) {
      setOut(`실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title="cherry-pick / reset">
        🍒 픽/리셋
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>🍒 cherry-pick / reset</h3>
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              <div className="ws-crud-row">
                <button type="button" className={`ws-tree-btn${tab === "cherry" ? " primary" : ""}`} onClick={() => setTab("cherry")}>
                  cherry-pick
                </button>
                <button type="button" className={`ws-tree-btn${tab === "reset" ? " primary" : ""}`} onClick={() => setTab("reset")}>
                  reset
                </button>
              </div>
              {tab === "cherry" ? (
                <>
                  <p className="ws-crud-hint">다른 브랜치/커밋의 SHA 를 현재 브랜치 위로 가져옵니다.</p>
                  <div className="ws-crud-row">
                    <input placeholder="가져올 커밋 SHA" value={sha} onChange={(e) => setSha(e.target.value)} disabled={busy} />
                    <button type="button" className="primary" disabled={busy || !sha.trim()} onClick={doCherryPick}>
                      ▶ 적용
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="ws-crud-hint">
                    <b>soft</b>: HEAD 만 이동 (변경은 staged).
                    <br /><b>mixed</b>: 기본. staged 도 해제, working tree 는 유지.
                    <br /><b>hard</b>: working tree 까지 그 SHA 로 되돌림 — 복구 불가.
                  </p>
                  <div className="ws-crud-row">
                    <input placeholder="대상 SHA / HEAD~N" value={sha} onChange={(e) => setSha(e.target.value)} disabled={busy} />
                    <select value={mode} onChange={(e) => setMode(e.target.value as "soft" | "mixed" | "hard")} disabled={busy}>
                      <option value="soft">soft</option>
                      <option value="mixed">mixed</option>
                      <option value="hard">hard</option>
                    </select>
                    <button type="button" className="primary" disabled={busy || !sha.trim()} onClick={doReset}>
                      ▶ reset
                    </button>
                  </div>
                </>
              )}
              {out && <pre className="wsc-review-body">{out}</pre>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #78 브랜치 비교 ──────────────────────────────────────
const CompareDiffEditor = lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.DiffEditor })),
);

export function ComparePanel({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [base, setBase] = useState("main");
  const [head, setHead] = useState("HEAD");
  const [branches, setBranches] = useState<string[]>([]);
  const [files, setFiles] = useState<{ status: string; path: string }[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<{ base: string; head: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.workspaceBranches(workspaceId).then((b) => {
      setBranches([...b.local, ...b.remote]);
      if (b.current) setHead(b.current);
    }).catch(() => {});
  }, [open, workspaceId]);

  async function run() {
    setBusy(true);
    setFiles(null);
    setSel(null);
    setFileDiff(null);
    try {
      const r = await api.workspaceCompare(workspaceId, base, head);
      setFiles(r.files);
    } catch (e) {
      errorToast("비교 실패", e);
    } finally {
      setBusy(false);
    }
  }
  async function openFile(path: string) {
    setSel(path);
    setFileDiff(null);
    try {
      const r = await api.workspaceCompareFile(workspaceId, base, head, path);
      setFileDiff({ base: r.base, head: r.head });
    } catch (e) {
      setFileDiff({ base: "", head: `(로드 실패: ${e})` });
    }
  }

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title="두 브랜치/커밋 비교">
        ↔ 비교
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal ws-log-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>↔ 브랜치 비교</h3>
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              <div className="ws-crud-row">
                <input placeholder="base (예: main)" value={base} onChange={(e) => setBase(e.target.value)} list="ws-cmp-branches" />
                <span>..</span>
                <input placeholder="head (예: feature/x)" value={head} onChange={(e) => setHead(e.target.value)} list="ws-cmp-branches" />
                <datalist id="ws-cmp-branches">
                  {branches.map((b) => <option key={b} value={b} />)}
                </datalist>
                <button type="button" className="primary" disabled={busy} onClick={run}>
                  {busy ? "…" : "▶ 비교"}
                </button>
              </div>
              {files && (
                <div className="ws-log-body">
                  <div className="ws-log-left">
                    {files.length === 0 ? (
                      <div className="patch-preview-empty">변경 없음</div>
                    ) : (
                      <ul className="ws-log-files">
                        {files.map((f) => (
                          <li key={f.path} onClick={() => openFile(f.path)} className={sel === f.path ? "active" : ""}>
                            <span className={`ws-log-status st-${f.status}`}>{f.status}</span>
                            <span>{f.path}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="ws-log-right">
                    {sel && fileDiff ? (
                      <Suspense fallback={<div className="patch-preview-empty">…</div>}>
                        <div className="wsc-diff-monaco">
                          <CompareDiffEditor
                            height="50vh"
                            original={fileDiff.base}
                            modified={fileDiff.head}
                            theme={
                              document.documentElement.getAttribute("data-theme") === "dark"
                                ? "vs-dark"
                                : "light"
                            }
                            options={{
                              readOnly: true,
                              renderSideBySide: true,
                              minimap: { enabled: false },
                              automaticLayout: true,
                            }}
                          />
                        </div>
                      </Suspense>
                    ) : (
                      <div className="patch-preview-empty">파일을 클릭하세요.</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #80 파일 outline ─────────────────────────────────────
export function OutlinePanel({
  workspaceId,
  filePath,
}: {
  workspaceId: string;
  filePath: string | null;
}) {
  type Item = {
    kind: string;
    name: string;
    line: number;
    level?: number;
  };
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open || !filePath) return;
    api.workspaceOutline(workspaceId, filePath).then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [open, workspaceId, filePath]);

  const filtered = q.trim()
    ? items.filter((it) => it.name.toLowerCase().includes(q.toLowerCase()))
    : items;

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} disabled={!filePath} title="파일 안 함수/클래스/heading 점프">
        🧭 outline
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>🧭 파일 outline</h3>
              {filePath && <code className="patch-preview-path">{filePath}</code>}
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              {!filePath ? (
                <div className="patch-preview-empty">먼저 트리에서 파일을 선택하세요.</div>
              ) : (
                <>
                  <input
                    className="ws-grep-input"
                    placeholder="이름으로 필터"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    autoFocus
                  />
                  {filtered.length === 0 ? (
                    <div className="patch-preview-empty">
                      {items.length === 0 ? "해당 확장자는 outline 지원 안 함" : "일치 없음"}
                    </div>
                  ) : (
                    <ul className="ws-todo-list">
                      {filtered.map((it, i) => (
                        <li key={`${it.line}-${i}`}>
                          <button
                            type="button"
                            onClick={() => {
                              window.dispatchEvent(
                                new CustomEvent("ws:goto-line", {
                                  detail: { path: filePath, line: it.line },
                                }),
                              );
                              setOpen(false);
                            }}
                          >
                            <span className={`ws-todo-tag tag-${it.kind === "class" ? "TODO" : it.kind === "func" ? "NOTE" : "HACK"}`}>
                              {it.kind}{it.level ? ` H${it.level}` : ""}
                            </span>
                            <code>{it.name}</code>
                            <span className="ws-todo-msg">L{it.line}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #81 컨트리뷰터 통계 ──────────────────────────────────
export function ContributorsPanel({ workspaceId }: { workspaceId: string }) {
  type Data = Awaited<ReturnType<typeof api.workspaceContributors>>;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    if (!open) return;
    api.workspaceContributors(workspaceId).then(setData).catch(() => setData(null));
  }, [open, workspaceId]);

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title="작성자별 커밋 통계">
        👥 사람
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>👥 컨트리뷰터</h3>
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              {!data ? (
                <div className="patch-preview-empty">불러오는 중…</div>
              ) : data.contributors.length === 0 ? (
                <div className="patch-preview-empty">기록 없음</div>
              ) : (
                <table className="ws-stats-table">
                  <thead>
                    <tr><th>이름</th><th>이메일</th><th>커밋</th><th>최근</th></tr>
                  </thead>
                  <tbody>
                    {data.contributors.map((c, i) => (
                      <tr key={`${c.email}-${i}`}>
                        <td>{c.name}</td>
                        <td><code>{c.email}</code></td>
                        <td>{c.commits.toLocaleString()}</td>
                        <td>{c.last_at ? new Date(c.last_at).toLocaleDateString() : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #82 활동 히트맵 ──────────────────────────────────────
export function ActivityPanel({ workspaceId }: { workspaceId: string }) {
  type Data = Awaited<ReturnType<typeof api.workspaceActivity>>;
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(365);
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    if (!open) return;
    api.workspaceActivity(workspaceId, days).then(setData).catch(() => setData(null));
  }, [open, workspaceId, days]);

  // weekday_hour → grid[7][24].
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  let maxV = 0;
  if (data) {
    for (const w of data.weekday_hour) {
      grid[w.weekday][w.hour] = w.count;
      if (w.count > maxV) maxV = w.count;
    }
  }

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title="요일·시간대별 커밋 빈도">
        🔥 활동
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>🔥 활동 히트맵</h3>
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              <div className="ws-crud-row">
                {[30, 90, 180, 365, 730].map((d) => (
                  <button key={d} type="button" className={`ws-tree-btn${days === d ? " primary" : ""}`} onClick={() => setDays(d)}>
                    {d}일
                  </button>
                ))}
              </div>
              {!data ? (
                <div className="patch-preview-empty">불러오는 중…</div>
              ) : (
                <div className="ws-heatmap">
                  <div className="ws-heatmap-row">
                    <span className="ws-heatmap-corner" />
                    {Array.from({ length: 24 }, (_, h) => (
                      <span key={h} className="ws-heatmap-hr">{h}</span>
                    ))}
                  </div>
                  {["월", "화", "수", "목", "금", "토", "일"].map((label, di) => (
                    <div key={label} className="ws-heatmap-row">
                      <span className="ws-heatmap-dow">{label}</span>
                      {grid[di].map((v, hi) => {
                        const alpha = maxV ? Math.min(1, v / maxV) : 0;
                        return (
                          <span
                            key={hi}
                            className="ws-heatmap-cell"
                            style={{ background: `rgba(204, 120, 92, ${alpha})` }}
                            title={`${label} ${hi}시 — ${v}건`}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}


// ── #83 심볼 전역 검색 ───────────────────────────────────
export function SymbolSearchPanel({
  workspaceId,
  onJump,
}: {
  workspaceId: string;
  onJump: (path: string, line: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<
    { path: string; line: number; kind: string; name: string }[]
  >([]);
  const [busy, setBusy] = useState(false);

  async function run() {
    if (q.trim().length < 2) return;
    setBusy(true);
    try {
      const r = await api.workspaceSymbols(workspaceId, q.trim());
      setResults(r.items);
    } catch (e) {
      errorToast("검색 실패", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title="함수·클래스·heading 전역 검색">
        🔭 심볼
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>🔭 심볼 전역 검색</h3>
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              <div className="ws-crud-row">
                <input
                  className="ws-grep-input"
                  placeholder="함수·클래스·heading 이름 (2자 이상)"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") run();
                  }}
                  autoFocus
                />
                <button type="button" className="primary" onClick={run} disabled={busy || q.trim().length < 2}>
                  {busy ? "…" : "검색"}
                </button>
              </div>
              {results.length === 0 ? (
                <div className="patch-preview-empty">{busy ? "검색 중…" : q ? "결과 없음" : "검색어를 입력하세요"}</div>
              ) : (
                <ul className="ws-todo-list">
                  {results.map((r, i) => (
                    <li key={`${r.path}:${r.line}:${i}`}>
                      <button
                        type="button"
                        onClick={() => {
                          onJump(r.path, r.line);
                          setOpen(false);
                        }}
                      >
                        <span className={`ws-todo-tag tag-${r.kind === "class" ? "TODO" : r.kind === "func" ? "NOTE" : "HACK"}`}>
                          {r.kind}
                        </span>
                        <code>{r.path}:{r.line}</code>
                        <span className="ws-todo-msg">{r.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #84 AI changelog ────────────────────────────────────
export function ChangelogPanel({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ commits: number; model: string } | null>(null);

  async function run() {
    setBusy(true);
    setText(null);
    setMeta(null);
    try {
      const r = await api.workspaceAiChangelog(workspaceId, days);
      setText(r.changelog);
      setMeta({ commits: r.commits, model: r.model });
    } catch (e) {
      setText(`실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title="최근 N일 변경 요약">
        📜 changelog
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>📜 AI 변경 요약</h3>
              {meta && (
                <code className="patch-preview-path">
                  {meta.commits}개 커밋 · {meta.model}
                </code>
              )}
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              <div className="ws-crud-row">
                {[1, 3, 7, 14, 30].map((d) => (
                  <button key={d} type="button" className={`ws-tree-btn${days === d ? " primary" : ""}`} onClick={() => setDays(d)}>
                    {d}일
                  </button>
                ))}
                <button type="button" className="primary" onClick={run} disabled={busy}>
                  {busy ? "생성 중…" : "▶ 생성"}
                </button>
              </div>
              {text && <pre className="wsc-review-body">{text}</pre>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #86 zip import ─────────────────────────────────────
export function ImportZipPanel({
  workspaceId,
  onChanged,
}: {
  workspaceId: string;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    extracted: number;
    total_bytes: number;
    skipped_count: number;
    skipped_sample: string[];
  } | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.workspaceImportZip(workspaceId, file);
      setResult(r);
      notifyTreeChanged();
      onChanged?.();
    } catch (e) {
      errorToast("zip 임포트 실패", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="ws-tree-btn" onClick={() => setOpen(true)} title="기존 zip 을 워크스페이스에 풀기">
        📦 zip 가져오기
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>📦 zip 가져오기</h3>
              <button type="button" className="modal-close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="patch-preview-body">
              <p className="ws-crud-hint">
                zip 안의 파일을 워크스페이스에 풀어 넣어요.  zip slip(..)
                경로는 자동 차단, 20MB 초과 파일·총 200MB 초과는 스킵.
              </p>
              <div className="ws-crud-row">
                <input
                  type="file"
                  accept=".zip"
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void upload(f);
                  }}
                />
              </div>
              {result && (
                <>
                  <div className="ws-stats-sec">결과</div>
                  <ul className="ws-branch-list">
                    <li><span>추출</span><span>{result.extracted}개</span></li>
                    <li><span>총 크기</span><span>{(result.total_bytes / 1024 / 1024).toFixed(1)} MB</span></li>
                    <li><span>건너뜀</span><span>{result.skipped_count}개</span></li>
                  </ul>
                  {result.skipped_sample.length > 0 && (
                    <pre className="wsc-review-body">
{`건너뛴 파일 (최대 10):\n${result.skipped_sample.join("\n")}`}
                    </pre>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── #87 다중 선택 + 일괄 삭제 ────────────────────────────
export function BulkSelectPanel({
  workspaceId,
  selected,
  onClear,
  onChanged,
}: {
  workspaceId: string;
  selected: string[];
  onClear: () => void;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (selected.length === 0) return null;

  async function bulkDelete() {
    if (
      !window.confirm(
        `선택한 ${selected.length}개를 삭제할까요? (폴더는 재귀)\n되돌릴 수 없어요.`,
      )
    )
      return;
    setBusy(true);
    try {
      const r = await api.workspaceBulkDelete(workspaceId, selected);
      notifyTreeChanged();
      const okN = r.deleted.length;
      const failN = r.failed.length;
      infoToast(
        `삭제 완료 — ok ${okN}건, 실패 ${failN}건` +
          (failN > 0 ? ` (자세한 사유는 콘솔)` : ""),
      );
      if (failN > 0 && typeof console !== "undefined") {
        console.warn("ws.delete failures", r.failed);
      }
      onChanged?.();
      onClear();
    } catch (e) {
      errorToast("삭제 실패", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ws-bulk-bar">
      <span>{selected.length}개 선택됨</span>
      <button type="button" disabled={busy} onClick={bulkDelete}>
        🗑 일괄 삭제
      </button>
      <button type="button" onClick={onClear}>
        선택 해제
      </button>
    </div>
  );
}
