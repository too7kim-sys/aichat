import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { errorToast, infoToast } from "../../lib/toast";
import { PIN_KEY, RECENT_KEY, notifyTreeChanged, readArr, writeArr } from "./_shared";

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
