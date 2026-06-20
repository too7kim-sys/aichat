import { Suspense, lazy, useEffect, useState } from "react";
import { api } from "../../api/client";
import { errorToast, infoToast } from "../../lib/toast";
import { notifyTreeChanged } from "./_shared";

const ConflictDiffEditor = lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.DiffEditor })));
const ConflictMonacoEditor = lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.default })));
const CompareDiffEditor = lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.DiffEditor })));

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
