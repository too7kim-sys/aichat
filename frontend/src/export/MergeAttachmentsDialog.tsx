import { useEffect, useMemo, useState } from "react";
import { api, type ExtractedFile } from "../api/client";

/** Attachment as held in ChatPanel's state — extends the wire
 *  ExtractedFile with an optional reference to the original browser
 *  File so the merge endpoint can re-receive the binary. */
export interface LocalAttachment extends ExtractedFile {
  _file?: File;
}

interface Props {
  open: boolean;
  onClose: () => void;
  attachments: LocalAttachment[];
  defaultTitle: string;
}

/** Format-preserving merge: same extension across all picked files,
 *  original binary available. Phase 1 supports these five only. */
const MERGEABLE_EXTS = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".hwpx"]);

const EXT_LABELS: Record<string, string> = {
  ".pdf": "PDF",
  ".docx": "Word (.docx)",
  ".xlsx": "Excel (.xlsx)",
  ".pptx": "PowerPoint (.pptx)",
  ".hwpx": "한글 (.hwpx)",
  ".hwp": "한글 (.hwp · 구버전)",
};

function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i).toLowerCase() : "";
}

function labelFor(ext: string): string {
  return EXT_LABELS[ext] || ext || "(확장자 없음)";
}

interface FileStatus {
  ok: boolean;
  reason?: string;
}

function classifyFile(
  a: LocalAttachment,
  commonExt: string,
): FileStatus {
  const e = extOf(a.filename);
  if (!MERGEABLE_EXTS.has(e)) {
    return { ok: false, reason: `${labelFor(e)} 형식은 병합 미지원 (Phase 1)` };
  }
  if (e !== commonExt) {
    return { ok: false, reason: `다른 형식 (${labelFor(e)})` };
  }
  if (!a._file) {
    return {
      ok: false,
      reason: "원본 파일이 없음 (텍스트로만 첨부됨)",
    };
  }
  return { ok: true };
}

export function MergeAttachmentsDialog({
  open,
  onClose,
  attachments,
  defaultTitle,
}: Props) {
  const [title, setTitle] = useState(defaultTitle);
  const [withSeparators, setWithSeparators] = useState(true);
  const [included, setIncluded] = useState<Set<number>>(
    () => new Set(attachments.map((_, i) => i)),
  );
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-sync default title when the parent's title changes (e.g.
  // session rename).
  useEffect(() => {
    setTitle(defaultTitle);
  }, [defaultTitle]);

  // Re-sync the selection when attachments mutate: add new indices,
  // drop indices past the new length.
  useEffect(() => {
    setIncluded((prev) => {
      const next = new Set<number>();
      for (let i = 0; i < attachments.length; i += 1) {
        if (prev.size === 0 || prev.has(i) || i >= prev.size) next.add(i);
      }
      return next;
    });
  }, [attachments.length]);

  // The "common extension" is whichever recognised format the
  // majority of currently-selected files share. If nothing's
  // recognised, we fall back to empty so the per-file status
  // messages still make sense.
  const commonExt = useMemo(() => {
    const tally = new Map<string, number>();
    attachments.forEach((a, i) => {
      if (!included.has(i)) return;
      const e = extOf(a.filename);
      if (MERGEABLE_EXTS.has(e)) {
        tally.set(e, (tally.get(e) || 0) + 1);
      }
    });
    let best = "";
    let bestN = 0;
    for (const [e, n] of tally) {
      if (n > bestN) {
        best = e;
        bestN = n;
      }
    }
    return best;
  }, [attachments, included]);

  const classified = useMemo(
    () => attachments.map((a) => classifyFile(a, commonExt)),
    [attachments, commonExt],
  );

  const chosenIdx = useMemo(
    () =>
      attachments
        .map((_, i) => i)
        .filter((i) => included.has(i) && classified[i].ok),
    [attachments, included, classified],
  );

  if (!open) return null;

  function toggleFile(i: number) {
    setIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function runMerge() {
    if (chosenIdx.length < 2) {
      setStatus("병합하려면 같은 형식의 원본 파일이 2개 이상 필요합니다.");
      return;
    }
    if (!title.trim()) {
      setStatus("문서 제목을 입력하세요.");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const files = chosenIdx.map((i) => attachments[i]._file as File);
      const { blob, filename } = await api.mergeFiles({
        files,
        title: title.trim(),
        withSeparators,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(
        `다운로드 완료 — ${filename} (${Math.round(blob.size / 1024)} KB)`,
      );
    } catch (e) {
      setStatus(`병합 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const tally = useMemo(() => {
    const m = new Map<string, number>();
    attachments.forEach((a) => {
      const e = extOf(a.filename);
      m.set(e, (m.get(e) || 0) + 1);
    });
    return m;
  }, [attachments]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal export-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="pm-head">
          <div className="pm-head-text">
            <h3>첨부 파일 병합</h3>
            <p>
              같은 형식의 파일을 원형 그대로 합쳐 하나의 문서로 만듭니다
              (PDF · Word · Excel · PowerPoint · 한글 HWPX).
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="닫기"
          >
            ✕
          </button>
        </header>

        <div className="export-body">
          <div className="pm-field">
            <label>감지된 형식</label>
            <div className="merge-format-tally">
              {Array.from(tally.entries()).map(([e, n]) => (
                <span key={e} className="merge-format-pill">
                  {labelFor(e)} × {n}
                </span>
              ))}
            </div>
            {commonExt && (
              <div className="pm-help">
                → <strong>{labelFor(commonExt)}</strong> 형식으로 병합 가능
                ({chosenIdx.length}개 파일)
              </div>
            )}
            {!commonExt && (
              <div className="pm-help warn">
                병합 가능한 형식의 파일이 2개 이상 필요합니다. 다른 형식이
                섞여 있으면 같은 형식끼리만 선택하세요.
              </div>
            )}
          </div>

          <div className="pm-field">
            <label>병합 결과 파일명</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              disabled={busy}
              placeholder="예: 회의자료 통합본"
            />
          </div>

          <div className="pm-field">
            <label>포함할 파일</label>
            <div className="merge-file-list">
              {attachments.map((a, i) => {
                const st = classified[i];
                return (
                  <label
                    key={i}
                    className={`merge-file-row${st.ok ? "" : " unmergeable"}`}
                    title={st.reason || ""}
                  >
                    <input
                      type="checkbox"
                      checked={included.has(i)}
                      onChange={() => toggleFile(i)}
                      disabled={busy || !st.ok}
                    />
                    <span className="merge-file-name" title={a.filename}>
                      {i + 1}. {a.filename}
                    </span>
                    <span className="merge-file-meta">
                      {st.ok ? labelFor(extOf(a.filename)) : st.reason}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="pm-field">
            <label className="export-checkbox">
              <input
                type="checkbox"
                checked={withSeparators}
                onChange={(e) => setWithSeparators(e.target.checked)}
                disabled={busy}
              />
              <span>
                파일 경계에 구분 표지 삽입
                <span className="pm-help inline">
                  {" — PDF는 표지 페이지, Excel은 구분 시트, PowerPoint는 표지 슬라이드, Word/HWPX는 제목 단락"}
                </span>
              </span>
            </label>
          </div>

          {status && <div className="export-status">{status}</div>}
        </div>

        <footer className="export-footer">
          <button
            type="button"
            className="pm-btn-secondary"
            onClick={onClose}
            disabled={busy}
          >
            취소
          </button>
          <button
            type="button"
            className="pm-btn-primary"
            onClick={runMerge}
            disabled={busy || chosenIdx.length < 2}
          >
            {busy
              ? "병합 중…"
              : `${labelFor(commonExt) || "—"}로 병합 다운로드`}
          </button>
        </footer>
      </div>
    </div>
  );
}
