import { useEffect, useState } from "react";
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
