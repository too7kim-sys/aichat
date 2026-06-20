import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { errorToast, infoToast } from "../../lib/toast";

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
