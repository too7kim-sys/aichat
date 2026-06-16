import { Suspense, lazy, useEffect, useState } from "react";
import { api } from "../api/client";

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
      onChanged?.();
      await refresh();
    } catch (e) {
      window.alert(`전환 실패: ${e instanceof Error ? e.message : String(e)}`);
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
      onChanged?.();
      setPath("");
      setOpen(false);
    } catch (e) {
      window.alert(`생성 실패: ${e instanceof Error ? e.message : String(e)}`);
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
    } catch (e) {
      window.alert(`치환 실패: ${e instanceof Error ? e.message : String(e)}`);
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
      onChanged?.();
      await refresh();
    } catch (e) {
      window.alert(`스태시 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }
  async function apply(ref: string, pop: boolean) {
    setBusy(true);
    try {
      await api.workspaceStashApply(workspaceId, ref, pop);
      onChanged?.();
      await refresh();
    } catch (e) {
      window.alert(`적용 실패: ${e instanceof Error ? e.message : String(e)}`);
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
      window.alert(`삭제 실패: ${e instanceof Error ? e.message : String(e)}`);
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
      onChanged?.();
      // refresh.
      const r = await api.workspaceConflicts(workspaceId);
      setPaths(r.paths);
      setSel(null);
      setData(null);
    } catch (e) {
      window.alert(`해결 실패: ${e instanceof Error ? e.message : String(e)}`);
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
      window.alert(`실행 실패: ${e instanceof Error ? e.message : String(e)}`);
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
      window.alert("먼저 트리에서 파일을 선택하세요.");
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
