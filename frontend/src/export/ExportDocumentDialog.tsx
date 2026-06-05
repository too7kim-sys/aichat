import { useMemo, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message as MessageOut } from "../types";
import {
  buildHtmlDocument,
  buildMarkdown,
  downloadBlob,
  printAsPdf,
  safeFileBasename,
  selectExportItems,
} from "./documentExport";

interface Props {
  open: boolean;
  onClose: () => void;
  messages: MessageOut[];
  selectedIds: Set<string>;
  defaultTitle: string;
}

type Format = "md" | "html" | "pdf";

export function ExportDocumentDialog({
  open,
  onClose,
  messages,
  selectedIds,
  defaultTitle,
}: Props) {
  const [title, setTitle] = useState(defaultTitle);
  const [includeUserPrompts, setIncludeUserPrompts] = useState(true);
  const [includeMeta, setIncludeMeta] = useState(true);
  const [format, setFormat] = useState<Format>("md");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const items = useMemo(
    () =>
      selectExportItems(messages, selectedIds, {
        title,
        includeUserPrompts,
        includeMeta,
      }),
    [messages, selectedIds, title, includeUserPrompts, includeMeta],
  );

  if (!open) return null;

  function buildContent(): { md: string; htmlDoc: string } {
    const md = buildMarkdown(items, {
      title,
      includeUserPrompts,
      includeMeta,
    });
    // Render the markdown server-side (string) so the saved HTML is
    // fully static — no React runtime needed when the user later
    // opens the file in Word or a browser.
    const innerHtml = renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>,
    );
    const htmlDoc = buildHtmlDocument(innerHtml, title);
    return { md, htmlDoc };
  }

  async function exportNow() {
    if (items.length === 0) {
      setStatus("선택된 메시지가 없습니다.");
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
      setStatus(`내보내기 실패: ${e instanceof Error ? e.message : String(e)}`);
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
            <h3>문서로 내보내기</h3>
            <p>
              선택한 {items.length}개 항목을 하나의 문서로 합쳐 저장하거나
              인쇄합니다.
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
            <div className="pm-help">
              {format === "md" &&
                "원본 그대로의 마크다운. Notion·Obsidian 등 어디든 붙여넣기 가능."}
              {format === "html" &&
                "스타일이 포함된 단일 HTML 파일. 브라우저나 Word에서 열 수 있음."}
              {format === "pdf" &&
                "새 창에서 인쇄 대화상자가 열립니다. 시스템의 \"PDF로 저장\"을 선택하세요."}
            </div>
          </div>

          <div className="pm-field">
            <label className="export-checkbox">
              <input
                type="checkbox"
                checked={includeUserPrompts}
                onChange={(e) => setIncludeUserPrompts(e.target.checked)}
                disabled={busy}
              />
              <span>질문(사용자 입력)도 함께 포함</span>
            </label>
            <label className="export-checkbox">
              <input
                type="checkbox"
                checked={includeMeta}
                onChange={(e) => setIncludeMeta(e.target.checked)}
                disabled={busy}
              />
              <span>시각 등 메타 정보 표시</span>
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
            disabled={busy || items.length === 0}
          >
            {busy
              ? "처리 중…"
              : format === "pdf"
              ? "인쇄 창 열기"
              : "다운로드"}
          </button>
        </footer>
      </div>
    </div>
  );
}
