import { useEffect, useState } from "react";
import { api, type WorkspaceTreeEntry } from "../api/client";
import {
  AIDocPanel,
  AIToolsPanel,
  BranchPanel,
  ConflictPanel,
  CustomTasksPanel,
  DependenciesPanel,
  FileCRUDPanel,
  LogPanel,
  RecentFilesPanel,
  ReplacePanel,
  SecurityPanel,
  SnippetPanel,
  StashPanel,
  StatsPanel,
  TagPanel,
  TimelinePanel,
  TodoPanel,
  recordRecentFile,
} from "./WorkspaceTools";
import { useAuth } from "../auth/AuthContext";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconFileText,
  IconFolder,
  IconX,
} from "./Icon";

interface Props {
  workspaceId: string;
  activePath?: string | null;
  onSelectFile: (path: string) => void | Promise<void>;
  /** Bump this to force a tree refetch (e.g., after a workspace sync). */
  refreshKey?: number | string;
}

/** Bundle status fetched alongside the tree. Each value is the raw
 *  status string from the backend (ok / oversize:N / unsupported-ext:.X
 *  / over-file-cap / …). Empty for non-ready workspaces. */
type BundleStatus = Awaited<ReturnType<typeof api.workspaceBundleStatus>>;

function fmtMB(b: number): string {
  return `${(b / 1024 / 1024).toFixed(b >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

/** Compact marker + tooltip text for one file's bundle status. The
 *  shape matches what the chat manifest sends to the model so a
 *  user seeing "⊘ 한도 초과" in the tree understands the same way
 *  the model does. */
function statusMarker(s: string | undefined): {
  glyph: string;
  cls: string;
  title: string;
} {
  if (!s) return { glyph: "·", cls: "ws-mark-skip", title: "상태 미확인" };
  if (s === "ok") return { glyph: "✓", cls: "ws-mark-ok", title: "본문 첨부됨" };
  if (s.startsWith("oversize:")) {
    const kb = Math.round(Number(s.split(":")[1] || 0) / 1024);
    return {
      glyph: "⊘",
      cls: "ws-mark-bad",
      title: `한도 초과 (${kb} KB > 파일당 한도). WORKSPACE_BUNDLE_MAX_BYTES_PER_FILE 조정 필요.`,
    };
  }
  if (s.startsWith("unsupported-ext:")) {
    const ext = s.split(":")[1] || "없음";
    return {
      glyph: "⊘",
      cls: "ws-mark-bad",
      title: `지원하지 않는 확장자 (${ext}). _TEXT_EXTS 허용 목록 외.`,
    };
  }
  if (s === "over-file-cap") {
    return {
      glyph: "…",
      cls: "ws-mark-warn",
      title: "파일 개수 한도 초과 (낮은 우선순위로 제외). WORKSPACE_BUNDLE_MAX_FILES 키우면 포함됨.",
    };
  }
  if (s === "over-byte-cap") {
    return {
      glyph: "…",
      cls: "ws-mark-warn",
      title: "합계 바이트 한도 초과로 제외. WORKSPACE_BUNDLE_MAX_TOTAL_BYTES 조정 필요.",
    };
  }
  if (s === "binary") return { glyph: "⊘", cls: "ws-mark-bad", title: "바이너리 파일" };
  if (s === "empty") return { glyph: "⊘", cls: "ws-mark-bad", title: "빈 파일" };
  if (s === "read-error") return { glyph: "!", cls: "ws-mark-bad", title: "읽기 실패" };
  return { glyph: "·", cls: "ws-mark-skip", title: s };
}

export function WorkspaceTree({
  workspaceId,
  activePath = null,
  onSelectFile,
  refreshKey,
}: Props) {
  const [tree, setTree] = useState<WorkspaceTreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [bundle, setBundle] = useState<BundleStatus | null>(null);
  // AI 리팩터 / 테스트 / 타임라인 패널이 '현재 어떤 파일에 대해' 작동할
  // 지를 알아야 하므로 트리 안에서 클릭된 마지막 경로를 추적.
  const [lastFile, setLastFile] = useState<string | null>(null);
  const [recentBump, setRecentBump] = useState(0);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "moderator";
  function handleSelectFile(p: string) {
    setLastFile(p);
    recordRecentFile(workspaceId, p);
    setRecentBump((b) => b + 1);
    void onSelectFile(p);
  }
  function insertSnippet(text: string) {
    // 채팅으로 보내기: chat:quote-pick 이벤트는 composer 에 prefill.
    window.dispatchEvent(
      new CustomEvent("chat:quote-pick", { detail: { text } }),
    );
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Fetch tree + bundle status in parallel — the bundle call
    // re-walks for inclusion reasons (same code path the next chat
    // turn runs), so it's the longer of the two. Tree shows up first
    // and the markers stream in once status lands.
    api
      .workspaceTree(workspaceId)
      .then((res) => {
        if (!cancelled) setTree(res.tree);
      })
      .catch(() => {
        if (!cancelled) setTree([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    api
      .workspaceBundleStatus(workspaceId)
      .then((res) => {
        if (!cancelled) setBundle(res);
      })
      .catch(() => {
        if (!cancelled) setBundle(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshKey]);

  return (
    <>
      <WorkspaceGrep workspaceId={workspaceId} onSelect={handleSelectFile} />
      <RecentFilesPanel
        workspaceId={workspaceId}
        onSelect={handleSelectFile}
        bumpKey={recentBump}
      />
      <div className="ws-tree-toolbar">
        <BranchPanel workspaceId={workspaceId} />
        <LogPanel workspaceId={workspaceId} />
        <FileCRUDPanel workspaceId={workspaceId} />
        <ReplacePanel workspaceId={workspaceId} />
        <TodoPanel workspaceId={workspaceId} onJump={handleSelectFile} />
        <StashPanel workspaceId={workspaceId} />
        <ConflictPanel workspaceId={workspaceId} />
        <CustomTasksPanel workspaceId={workspaceId} />
        <AIToolsPanel workspaceId={workspaceId} filePath={lastFile} />
        <AIDocPanel workspaceId={workspaceId} filePath={lastFile} />
        <TimelinePanel workspaceId={workspaceId} filePath={lastFile} />
        <TagPanel workspaceId={workspaceId} />
        <SecurityPanel workspaceId={workspaceId} onJump={handleSelectFile} />
        <DependenciesPanel workspaceId={workspaceId} />
        <SnippetPanel onInsert={insertSnippet} isAdmin={!!isAdmin} />
        <StatsPanel workspaceId={workspaceId} />
        <TestRunnerButton workspaceId={workspaceId} />
        <RunCommandButton
          workspaceId={workspaceId}
          kind="lint"
          label="린트"
          emoji="🩺"
        />
        <RunCommandButton
          workspaceId={workspaceId}
          kind="format"
          label="포맷"
          emoji="🪄"
        />
        <RunCommandButton
          workspaceId={workspaceId}
          kind="build"
          label="빌드"
          emoji="📦"
        />
        <button
          type="button"
          className="ws-tree-btn"
          onClick={() => api.downloadWorkspaceZip(workspaceId)}
          title="워크스페이스를 zip 으로 다운로드 (.git / node_modules 등 제외)"
        >
          ⬇ zip
        </button>
      </div>
      {bundle && (
        <BundleStatusBanner bundle={bundle} />
      )}
      {loading ? (
        <div className="ws-tree-loading">트리 로드 중…</div>
      ) : tree.length === 0 ? (
        <div className="ws-tree-loading">파일이 없습니다</div>
      ) : (
        <TreeList
          items={tree}
          depth={0}
          activePath={activePath}
          onSelect={handleSelectFile}
          fileStatus={bundle?.file_status ?? {}}
        />
      )}
    </>
  );
}

/** Pre-flight summary above the tree — total / bundled counts, plus
 *  the three .env knobs so the operator sees the caps before asking
 *  why an analysis came back generic. */
function BundleStatusBanner({ bundle }: { bundle: BundleStatus }) {
  const missing = bundle.total_files_in_repo - bundle.bundled_files;
  const fileCapHit =
    bundle.bundled_files >= bundle.caps.max_files;
  const byteCapHit =
    bundle.bundled_bytes >=
    bundle.caps.max_total_bytes - bundle.caps.max_bytes_per_file;
  const tone = bundle.walk_error
    ? "ws-bundle-banner err"
    : missing > 0
    ? "ws-bundle-banner warn"
    : "ws-bundle-banner ok";
  return (
    <div className={tone}>
      <div className="ws-bundle-banner-head">
        {bundle.walk_error ? (
          <IconAlertTriangle size={13} />
        ) : missing > 0 ? (
          <IconAlertTriangle size={13} />
        ) : (
          <IconCheck size={13} />
        )}
        <strong>
          자동 첨부 {bundle.bundled_files.toLocaleString()}/
          {bundle.total_files_in_repo.toLocaleString()} 파일
        </strong>
        <span className="ws-bundle-banner-bytes">
          ({fmtMB(bundle.bundled_bytes)} / {fmtMB(bundle.caps.max_total_bytes)})
        </span>
      </div>
      {bundle.walk_error && (
        <div className="ws-bundle-banner-msg">
          폴더 읽기 실패: {bundle.walk_error}
        </div>
      )}
      {missing > 0 && (
        <div className="ws-bundle-banner-msg">
          {missing.toLocaleString()}개 미포함
          {fileCapHit && " · 파일 개수 한도 도달"}
          {byteCapHit && " · 합계 바이트 한도 임계"}
          {bundle.skipped_too_large > 0 &&
            ` · 단일 파일 ${bundle.skipped_too_large}개 한도 초과`}
          {bundle.skipped_unsupported_ext > 0 &&
            ` · ${bundle.skipped_unsupported_ext}개 미지원 확장자`}
          {(fileCapHit || byteCapHit || bundle.skipped_too_large > 0) && (
            <details className="ws-bundle-caps">
              <summary>현재 한도 (.env) 보기</summary>
              <ul>
                <li>
                  <code>WORKSPACE_BUNDLE_MAX_FILES</code> ={" "}
                  {bundle.caps.max_files.toLocaleString()}
                </li>
                <li>
                  <code>WORKSPACE_BUNDLE_MAX_BYTES_PER_FILE</code> ={" "}
                  {bundle.caps.max_bytes_per_file.toLocaleString()}
                </li>
                <li>
                  <code>WORKSPACE_BUNDLE_MAX_TOTAL_BYTES</code> ={" "}
                  {bundle.caps.max_total_bytes.toLocaleString()}
                </li>
              </ul>
            </details>
          )}
        </div>
      )}
      <div className="ws-bundle-banner-legend">
        <span className="ws-mark-ok">✓</span> 첨부 ·{" "}
        <span className="ws-mark-warn">…</span> 한도 초과 ·{" "}
        <span className="ws-mark-bad">⊘</span> 제외
      </div>
    </div>
  );
}

function TreeList({
  items,
  depth,
  activePath,
  onSelect,
  fileStatus,
  parentPath = "",
}: {
  items: WorkspaceTreeEntry[];
  depth: number;
  activePath: string | null;
  onSelect: (path: string) => void | Promise<void>;
  fileStatus: Record<string, string>;
  parentPath?: string;
}) {
  return (
    <ul className="ws-tree-list">
      {items.map((e) => (
        <TreeNode
          key={e.path}
          entry={e}
          depth={depth}
          activePath={activePath}
          onSelect={onSelect}
          fileStatus={fileStatus}
          parentPath={parentPath}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  entry,
  depth,
  activePath,
  onSelect,
  fileStatus,
  parentPath,
}: {
  entry: WorkspaceTreeEntry;
  depth: number;
  activePath: string | null;
  onSelect: (path: string) => void | Promise<void>;
  fileStatus: Record<string, string>;
  parentPath: string;
}) {
  const [open, setOpen] = useState(depth < 1);
  const pad = { paddingLeft: 8 + depth * 12 };

  if (entry.kind === "dir") {
    const sub = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    return (
      <li className="ws-tn dir">
        <button
          type="button"
          className="ws-tn-row"
          style={pad}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? (
            <IconChevronDown size={11} />
          ) : (
            <IconChevronRight size={11} />
          )}
          <IconFolder size={13} />
          <span className="ws-tn-name">{entry.name}</span>
        </button>
        {open && (
          <TreeList
            items={entry.children}
            depth={depth + 1}
            activePath={activePath}
            onSelect={onSelect}
            fileStatus={fileStatus}
            parentPath={sub}
          />
        )}
      </li>
    );
  }
  const fullPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  const mark = statusMarker(fileStatus[fullPath]);
  return (
    <li className="ws-tn file">
      <button
        type="button"
        className={`ws-tn-row${activePath === entry.path ? " active" : ""}`}
        style={pad}
        onClick={() => onSelect(entry.path)}
        title={`${entry.path}\n${mark.title}`}
      >
        <span className={`ws-tn-mark ${mark.cls}`} aria-hidden>
          {mark.glyph}
        </span>
        <IconFileText size={13} />
        <span className="ws-tn-name">{entry.name}</span>
      </button>
    </li>
  );
}

/**
 * 단위테스트 자동 실행 버튼. 서버가 WORKSPACE_TESTS_ENABLED=true 이고
 * 워크스페이스 루트에서 알려진 러너(pytest / npm test / cargo / mvn /
 * gradle / go) 가 감지될 때만 노출. 실행 결과는 모달에 stdout/stderr +
 * exit code 로 표시 — 사용자가 그대로 채팅에 복붙해 다음 턴 컨텍스트로.
 */
function TestRunnerButton({ workspaceId }: { workspaceId: string }) {
  type Info = Awaited<ReturnType<typeof api.workspaceTestRunner>>;
  type Result = Awaited<ReturnType<typeof api.runWorkspaceTests>>;
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    api.workspaceTestRunner(workspaceId).then((r) => {
      if (alive) setInfo(r);
    }).catch(() => { /* skip */ });
    return () => { alive = false; };
  }, [workspaceId]);

  if (!info?.enabled || !info?.runner) return null;

  async function run() {
    setBusy(true);
    setOpen(true);
    setResult(null);
    try {
      const r = await api.runWorkspaceTests(workspaceId);
      setResult(r);
    } catch (e) {
      setResult({
        runner: info!.runner, ok: false, skipped: false,
        exit_code: null, stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        duration_ms: 0,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="ws-tree-btn"
        onClick={run}
        disabled={busy}
        title={`${info.runner} 한 번 실행 (강제 timeout 적용)`}
      >
        {busy ? "⏳ 테스트…" : `🧪 테스트 (${info.runner})`}
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>테스트 결과</h3>
              {result && (
                <code className="patch-preview-path">
                  {result.runner} · {result.ok ? "✅ pass" : "❌ fail"}
                  {result.exit_code !== null && ` (exit ${result.exit_code})`}
                  {` · ${result.duration_ms} ms`}
                </code>
              )}
              <button
                type="button"
                className="modal-close"
                onClick={() => setOpen(false)}
                aria-label="닫기"
              >×</button>
            </header>
            <div className="patch-preview-body">
              {busy ? (
                <div className="patch-preview-empty">실행 중…</div>
              ) : result ? (
                <>
                  {result.stdout && (
                    <>
                      <div className="patch-preview-meta">STDOUT</div>
                      <pre className="patch-preview-diff">{result.stdout}</pre>
                    </>
                  )}
                  {result.stderr && (
                    <>
                      <div className="patch-preview-meta" style={{ marginTop: 10 }}>STDERR</div>
                      <pre className="patch-preview-diff">{result.stderr}</pre>
                    </>
                  )}
                  {!result.stdout && !result.stderr && (
                    <div className="patch-preview-empty">
                      출력이 없습니다 (exit {String(result.exit_code)}).
                    </div>
                  )}
                </>
              ) : null}
            </div>
            <footer>
              <button
                type="button"
                className="pm-btn-secondary"
                onClick={() => setOpen(false)}
              >
                닫기
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}


// ── 빌드 / 린트 / 포맷 버튼 (#56) ────────────────────────────
function RunCommandButton({
  workspaceId,
  kind,
  label,
  emoji,
}: {
  workspaceId: string;
  kind: "build" | "lint" | "format";
  label: string;
  emoji: string;
}) {
  type Result = Awaited<ReturnType<typeof api.runWorkspaceCommand>>;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [open, setOpen] = useState(false);

  async function run() {
    setBusy(true);
    setOpen(true);
    setResult(null);
    try {
      const r = await api.runWorkspaceCommand(workspaceId, kind);
      setResult(r);
    } catch (e) {
      setResult({
        runner: null,
        kind,
        ok: false,
        skipped: false,
        exit_code: null,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        duration_ms: 0,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="ws-tree-btn"
        onClick={run}
        disabled={busy}
        title={`${label} 자동 감지 후 실행`}
      >
        {busy ? `⏳ ${label}…` : `${emoji} ${label}`}
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div
            className="modal patch-preview-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <h3>{label} 결과</h3>
              {result && (
                <code className="patch-preview-path">
                  {result.runner || "자동 감지 실패"}
                  {!result.skipped &&
                    ` · ${result.ok ? "✅ ok" : "❌ fail"}${
                      result.exit_code !== null
                        ? ` (exit ${result.exit_code})`
                        : ""
                    }`}
                  {` · ${result.duration_ms} ms`}
                </code>
              )}
              <button
                type="button"
                className="modal-close"
                onClick={() => setOpen(false)}
                aria-label="닫기"
              >
                ×
              </button>
            </header>
            <div className="patch-preview-body">
              {busy ? (
                <div className="patch-preview-empty">실행 중…</div>
              ) : result?.skipped ? (
                <div className="patch-preview-empty">
                  {result.reason || "자동 감지 실패"}
                </div>
              ) : result ? (
                <>
                  {result.stdout && (
                    <>
                      <div className="patch-preview-meta">STDOUT</div>
                      <pre className="patch-preview-diff">{result.stdout}</pre>
                    </>
                  )}
                  {result.stderr && (
                    <>
                      <div
                        className="patch-preview-meta"
                        style={{ marginTop: 10 }}
                      >
                        STDERR
                      </div>
                      <pre className="patch-preview-diff">{result.stderr}</pre>
                    </>
                  )}
                  {!result.stdout && !result.stderr && (
                    <div className="patch-preview-empty">
                      출력이 없습니다 (exit {String(result.exit_code)}).
                    </div>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  );
}


// ── 워크스페이스 grep (#54) ─────────────────────────────────
// 트리 위쪽에 작은 검색 입력 + 결과 박스.  파일 이름 클릭 시 부모
// onSelectFile 콜백으로 파일 열림.
export function WorkspaceGrep({
  workspaceId,
  onSelect,
}: {
  workspaceId: string;
  onSelect: (path: string) => void;
}) {
  const [q, setQ] = useState("");
  const [regex, setRegex] = useState(false);
  const [results, setResults] = useState<
    { path: string; line: number; snippet: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (q.trim().length < 2) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.workspaceGrep(workspaceId, q.trim(), {
        regex,
        limit: 200,
      });
      setResults(r.results);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setResults([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ws-grep">
      <div className="ws-grep-row">
        <input
          className="ws-grep-input"
          placeholder="🔍 코드 검색 (2자 이상)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              run();
            }
          }}
        />
        <label className="ws-grep-toggle" title="정규식으로 해석">
          <input
            type="checkbox"
            checked={regex}
            onChange={(e) => setRegex(e.target.checked)}
          />
          regex
        </label>
        <button
          type="button"
          className="ws-tree-btn"
          onClick={run}
          disabled={busy || q.trim().length < 2}
        >
          {busy ? "⏳" : "검색"}
        </button>
      </div>
      {err && <div className="ws-grep-err">⚠ {err}</div>}
      {results.length > 0 && (
        <ul className="ws-grep-results">
          {results.map((r, i) => (
            <li key={`${r.path}:${r.line}:${i}`}>
              <button type="button" onClick={() => onSelect(r.path)}>
                <span className="ws-grep-path">
                  {r.path}:{r.line}
                </span>
                <code className="ws-grep-snip">{r.snippet}</code>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
