import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { errorToast } from "../../lib/toast";
import { PIN_KEY, RECENT_KEY, readArr, writeArr } from "./_shared";

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
/** 트리 상단 작은 박스 — 즐겨찾기 + 최근 본 파일.  WorkspaceTree 가
 *  파일을 열 때 record() 를 호출해 LS 에 push, 컴포넌트가 그걸 다시
 *  읽어 보여준다.  ★ 클릭 = 핀 토글. */
