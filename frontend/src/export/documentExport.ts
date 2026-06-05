/**
 * Document export — builds Markdown / HTML / printable document
 * payloads from a chat session's messages.
 *
 * No new npm deps: Markdown comes out as raw text, HTML is a self-
 * contained page (inline styles, no external assets), PDF is delegated
 * to window.print() in a popup so the user can pick the OS's built-in
 * "Save as PDF" target. This keeps the bundle small and works in a
 * closed network without server-side conversion tooling.
 */

import type { Message } from "../types";
import type { ExtractedFile } from "../api/client";

// Alias kept for the rest of the module's signatures so a future
// rename of the global Message type only needs one swap here.
type MessageOut = Message;

export interface ExportItem {
  message: MessageOut;
  /** Optional human label like "턴 3" rendered above each section. */
  turnLabel?: string;
}

export interface ExportOptions {
  title: string;
  includeUserPrompts: boolean;
  /** When false the timestamp + provider footnote under each block is
   *  skipped — keeps the output cleaner for handoff documents. */
  includeMeta: boolean;
}

/** A safe-ish basename derived from the document title — used as the
 *  download filename. Path separators stripped, control characters
 *  dropped, max 80 chars. */
export function safeFileBasename(raw: string): string {
  const cleaned = (raw || "")
    .replace(/[\\/]/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "chat-export";
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Pick the messages the user asked to export, in the order they
 *  appeared in the conversation. The `includeUserPrompts` flag drops
 *  user turns when false. Selecting a single assistant message will
 *  still bring along its immediately-preceding user message when the
 *  flag is on (gives the answer its question for context). */
export function selectExportItems(
  messages: MessageOut[],
  selectedIds: Set<string>,
  options: ExportOptions,
): ExportItem[] {
  const out: ExportItem[] = [];
  let turn = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role === "user") turn += 1;
    const chosen = selectedIds.has(m.id);
    if (!chosen) continue;
    if (m.role === "user" && !options.includeUserPrompts) continue;

    // When pulling an assistant message in include-prompts mode, also
    // pull the directly-preceding user prompt if it wasn't already
    // selected — keeps the question with its answer.
    if (
      m.role === "assistant" &&
      options.includeUserPrompts &&
      i > 0 &&
      messages[i - 1].role === "user" &&
      !selectedIds.has(messages[i - 1].id)
    ) {
      const prev = messages[i - 1];
      // Count the turn for the implicit user prompt too — same as the
      // assistant we're attaching it to.
      out.push({ message: prev, turnLabel: `턴 ${turn}` });
    }
    out.push({ message: m, turnLabel: `턴 ${turn}` });
  }
  return out;
}

/** Build a single Markdown document from the chosen messages. The
 *  output is plain Markdown — assistant content that already contains
 *  ```fenced code``` blocks survives intact, headings get a `## 질문 /
 *  ## 답변` framing. */
export function buildMarkdown(
  items: ExportItem[],
  options: ExportOptions,
): string {
  const parts: string[] = [];
  parts.push(`# ${options.title || "Untitled"}`);
  parts.push("");
  parts.push(`> 내보낸 시각: ${new Date().toLocaleString()}`);
  parts.push("");
  parts.push("---");
  parts.push("");
  for (const item of items) {
    const m = item.message;
    if (m.role === "user") {
      parts.push(
        `## ${item.turnLabel ? item.turnLabel + " · " : ""}질문`,
      );
      parts.push("");
      parts.push(m.content);
      parts.push("");
    } else {
      parts.push(
        `## ${item.turnLabel ? item.turnLabel + " · " : ""}답변` +
          (m.provider ? ` *(${m.provider})*` : ""),
      );
      parts.push("");
      parts.push(m.content);
      parts.push("");
    }
    if (options.includeMeta) {
      parts.push(`<sub>${fmtTime(m.created_at)}</sub>`);
      parts.push("");
    }
    parts.push("---");
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n");
}

// --- Attachment merge --------------------------------------------------
//
// The attachment-merge feature lets the user take everything they've
// dropped into the composer (PDF / DOCX / text / code / images) and
// roll it into a single document — useful for handing a curated bundle
// off to a colleague or for keeping a snapshot of the source material
// alongside the chat that consumed it.
//
// The merge re-uses the same Markdown → HTML → print pipeline as the
// answer exporter; only the section-building logic differs.

export interface AttachmentExportOptions {
  title: string;
  includeMeta: boolean;
  /** Inline image-typed attachments as base64 data URLs so the
   *  exported document is fully self-contained (the HTML/PDF still
   *  shows the picture without a separate file or network). */
  embedImages: boolean;
}

function guessImageMime(filename: string): string {
  const n = filename.toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".bmp")) return "image/bmp";
  if (n.endsWith(".tif") || n.endsWith(".tiff")) return "image/tiff";
  return "image/jpeg";
}

/** Build the merged-attachments Markdown. Order is preserved from
 *  the incoming list; images render inline as data URLs when
 *  embedImages is on so the resulting document carries the picture
 *  with it. */
export function buildAttachmentsMarkdown(
  attachments: ExtractedFile[],
  options: AttachmentExportOptions,
): string {
  const parts: string[] = [];
  parts.push(`# ${options.title || "병합 문서"}`);
  parts.push("");
  parts.push(
    `> 첨부 ${attachments.length}개 병합 · 내보낸 시각: ${new Date().toLocaleString()}`,
  );
  parts.push("");
  parts.push("---");
  parts.push("");
  attachments.forEach((a, i) => {
    parts.push(`## ${i + 1}. ${a.filename}`);
    parts.push("");
    if (options.includeMeta) {
      const bits: string[] = [];
      bits.push(a.method);
      bits.push(`${a.char_count.toLocaleString()}자`);
      if (a.image_b64) bits.push("이미지");
      parts.push(`<sub>${bits.join(" · ")}</sub>`);
      parts.push("");
    }
    if (a.image_b64 && options.embedImages) {
      const mime = guessImageMime(a.filename);
      parts.push(
        `![${a.filename}](data:${mime};base64,${a.image_b64})`,
      );
      parts.push("");
    }
    const body = (a.text || "").trim();
    if (body) {
      parts.push(body);
      parts.push("");
    } else if (!a.image_b64) {
      parts.push("_(추출된 텍스트가 없습니다)_");
      parts.push("");
    }
    parts.push("---");
    parts.push("");
  });
  return parts.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Wrap a Markdown rendering inside a self-contained HTML document so
 *  the user can open it in a browser or import into Word. The markdown
 *  is rendered to HTML by react-markdown on the caller side; this just
 *  wraps the HTML string in a styled <body>. */
export function buildHtmlDocument(
  innerHtml: string,
  title: string,
): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Apple SD Gothic Neo", "Noto Sans CJK KR", sans-serif;
    color: #1f2937;
    background: #ffffff;
    max-width: 780px;
    margin: 40px auto;
    padding: 0 24px 80px;
    line-height: 1.65;
    font-size: 15px;
  }
  h1 { font-size: 24px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; }
  h2 { font-size: 18px; margin-top: 32px; color: #111827; }
  h3 { font-size: 15.5px; color: #111827; }
  p { margin: 10px 0; }
  pre {
    background: #0f172a;
    color: #f1f5f9;
    padding: 14px 16px;
    border-radius: 8px;
    overflow-x: auto;
    font-size: 13px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    line-height: 1.55;
  }
  code {
    background: #f1f5f9;
    color: #0f172a;
    padding: 1px 5px;
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
  }
  pre code { background: transparent; padding: 0; color: inherit; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 28px 0; }
  blockquote {
    border-left: 4px solid #e5e7eb;
    margin: 10px 0;
    padding: 4px 14px;
    color: #4b5563;
    background: #f9fafb;
  }
  table { border-collapse: collapse; margin: 12px 0; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; }
  th { background: #f3f4f6; }
  ul, ol { padding-left: 26px; }
  sub { color: #6b7280; font-size: 11px; }
  @media print {
    body { margin: 0; padding: 12mm 14mm; font-size: 11pt; max-width: none; }
    pre, blockquote, table { page-break-inside: avoid; }
    h1, h2, h3 { page-break-after: avoid; }
  }
</style>
</head>
<body>
${innerHtml}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Trigger a browser download of the given content as a file. */
export function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Open the rendered HTML in a new popup window and trigger the
 *  browser print dialog — the user picks "PDF로 저장" from the system
 *  print sheet. Works without any heavy PDF library or backend
 *  conversion. Returns false if the popup is blocked. */
export function printAsPdf(htmlDoc: string): boolean {
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.open();
  w.document.write(htmlDoc);
  w.document.close();
  // Some browsers (Safari, mobile Chrome) need the assets to settle
  // before print() fires reliably. A short delay handles both.
  window.setTimeout(() => {
    try {
      w.focus();
      w.print();
    } catch {
      /* swallow — user can still print manually */
    }
  }, 250);
  return true;
}
