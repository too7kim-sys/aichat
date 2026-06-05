import { useEffect, useMemo, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ExtractedFile } from "../api/client";
import {
  buildAttachmentsMarkdown,
  buildHtmlDocument,
  downloadBlob,
  printAsPdf,
  safeFileBasename,
} from "./documentExport";

interface Props {
  open: boolean;
  onClose: () => void;
  attachments: ExtractedFile[];
  defaultTitle: string;
}

type Format = "md" | "html" | "pdf";

export function MergeAttachmentsDialog({
  open,
  onClose,
  attachments,
  defaultTitle,
}: Props) {
  const [title, setTitle] = useState(defaultTitle);
  const [includeMeta, setIncludeMeta] = useState(true);
  const [embedImages, setEmbedImages] = useState(true);
  // Per-file include flags so the user can drop one or two files
  // from the merge without having to remove them from the composer
  // (which would also drop them from the chat context).
  const [included, setIncluded] = useState<Set<number>>(
    new Set(attachments.map((_, i) => i)),
  );
  // The attachment list can change while the dialog is open (rare —
  // usually the user closes the composer pane first — but if a
  // pending upload finishes mid-flow we re-sync to include the new
  // index by default rather than silently leaving it out).
  useEffect(() => {
    setIncluded((prev) => {
      const next = new Set<number>();
      for (let i = 0; i < attachments.length; i += 1) {
        if (prev.size === 0 || prev.has(i)) next.add(i);
      }
      // If the previous selection was a strict subset, only add
      // brand-new indices (everything past the previous max).
      if (prev.size > 0 && prev.size < attachments.length) {
        const prevMax = Math.max(...prev);
        for (let i = prevMax + 1; i < attachments.length; i += 1) {
          next.add(i);
        }
      }
      return next;
    });
  }, [attachments.length]);
  const [format, setFormat] = useState<Format>("md");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const chosen = useMemo(
    () => attachments.filter((_, i) => included.has(i)),
    [attachments, included],
  );
  const totalChars = useMemo(
    () => chosen.reduce((acc, a) => acc + a.char_count, 0),
    [chosen],
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

  function buildContent(): { md: string; htmlDoc: string } {
    const md = buildAttachmentsMarkdown(chosen, {
      title,
      includeMeta,
      embedImages,
    });
    const innerHtml = renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>,
    );
    return { md, htmlDoc: buildHtmlDocument(innerHtml, title) };
  }

  async function exportNow() {
    if (chosen.length === 0) {
      setStatus("병합할 파일을 1개 이상 선택하세요.");
      return;
    }
    if (!title.trim()) {
      setStatus("문서 제목을 입력하세요.");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const { md, htmlDoc } = buildContent();
      const base = safeFileBasename(title);
      if (format === "md") {
        downloadBlob(md, `${base}.md`, "text/markdown");
      } else if (format === "html") {
        downloadBlob(htmlDoc, `${base}.html`, "text/html");
      } else {
        const ok = printAsPdf(htmlDoc);
        if (!ok) {
          setStatus(
            "팝업이 차단되어 PDF 인쇄 창을 열 수 없습니다. 팝업 차단을 해제하거나 .html 형식으로 저장 후 인쇄하세요.",
          );
          setBusy(false);
          return;
        }
      }
      setStatus(
        format === "pdf"
          ? "새 창에서 인쇄 대화상자를 열었습니다. \"PDF로 저장\"을 선택하세요."
          : `다운로드 완료 — ${base}.${format}`,
      );
    } catch (e) {
      setStatus(
        `병합 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(false);
    }
  }

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
              {chosen.length}/{attachments.length}개 파일 ·
              총 {totalChars.toLocaleString()}자를 하나의 문서로 합칩니다.
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
            <label>문서 제목</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              disabled={busy}
            />
          </div>

          <div className="pm-field">
            <label>포함할 파일</label>
            <div className="merge-file-list">
              {attachments.map((a, i) => (
                <label key={i} className="merge-file-row">
                  <input
                    type="checkbox"
                    checked={included.has(i)}
                    onChange={() => toggleFile(i)}
                    disabled={busy}
                  />
                  <span className="merge-file-name" title={a.filename}>
                    {i + 1}. {a.filename}
                  </span>
                  <span className="merge-file-meta">
                    {a.image_b64 ? "🖼" : "📄"} {a.method} ·{" "}
                    {a.char_count.toLocaleString()}자
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="pm-field">
            <label>형식</label>
            <div className="export-format-tabs" role="tablist">
              {(["md", "html", "pdf"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={format === f}
                  className={`export-format-tab${
                    format === f ? " active" : ""
                  }`}
                  onClick={() => setFormat(f)}
                  disabled={busy}
                >
                  {f === "md"
                    ? "Markdown (.md)"
                    : f === "html"
                    ? "HTML (.html)"
                    : "PDF (브라우저 인쇄)"}
                </button>
              ))}
            </div>
          </div>

          <div className="pm-field">
            <label className="export-checkbox">
              <input
                type="checkbox"
                checked={embedImages}
                onChange={(e) => setEmbedImages(e.target.checked)}
                disabled={busy}
              />
              <span>이미지 첨부를 문서에 인라인으로 삽입</span>
            </label>
            <label className="export-checkbox">
              <input
                type="checkbox"
                checked={includeMeta}
                onChange={(e) => setIncludeMeta(e.target.checked)}
                disabled={busy}
              />
              <span>파일 메타(추출 방식·글자 수) 표시</span>
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
            onClick={exportNow}
            disabled={busy || chosen.length === 0}
          >
            {busy
              ? "처리 중…"
              : format === "pdf"
              ? "인쇄 창 열기"
              : "병합 다운로드"}
          </button>
        </footer>
      </div>
    </div>
  );
}
