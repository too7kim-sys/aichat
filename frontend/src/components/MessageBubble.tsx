import { useState } from "react";
import type { AttachmentSummary } from "../api/client";
import { BubbleContent } from "./BubbleContent";

interface Props {
  role: "user" | "assistant";
  provider?: string | null;
  content: string;
  streaming?: boolean;
  artifactTitlePrefix?: string;
  /** Compact list of files that travelled with this user message —
   *  rendered as small chips above the prompt text so the bubble
   *  preserves "I attached report.pdf + chart.png" context on
   *  reload. No-op for assistant bubbles. */
  attachments?: AttachmentSummary[] | null;
  /** When set, the bubble shows a select checkbox so the user can
   *  pick it for the "export to document" flow. The parent owns the
   *  selection state — the bubble just toggles the bound flag. */
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}

/** Tiny icon + label helpers — duplicated from ChatPanel.tsx's
 *  attachment-chip renderer on purpose so the bubble doesn't pull
 *  in the entire ChatPanel module. Kept short. */
function bubbleAttachmentIcon(filename: string, kind: string): string {
  if (kind === "image") return "🖼️";
  const ext = filename.toLowerCase().split(".").pop() || "";
  if (ext === "pdf") return "📕";
  if (["docx", "doc"].includes(ext)) return "📘";
  if (["xlsx", "xls", "csv", "tsv"].includes(ext)) return "📗";
  if (["pptx", "ppt"].includes(ext)) return "📙";
  if (["hwpx", "hwp"].includes(ext)) return "📜";
  return "📄";
}

function bubbleAttachmentBasename(filename: string): string {
  const slash = filename.lastIndexOf("/");
  return slash >= 0 ? filename.slice(slash + 1) : filename;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } finally {
        document.body.removeChild(ta);
      }
    }
  }

  return (
    <button
      type="button"
      className={`copy-btn ${copied ? "copied" : ""}`}
      onClick={handleCopy}
      aria-label="복사"
      title={copied ? "복사됨" : "복사"}
    >
      {copied ? "✓ 복사됨" : "📋 복사"}
    </button>
  );
}

export function MessageBubble({
  role,
  provider,
  content,
  streaming,
  artifactTitlePrefix,
  attachments,
  selectionMode,
  selected,
  onToggleSelect,
}: Props) {
  const selectCheckbox = selectionMode ? (
    <label
      className={`bubble-select${selected ? " checked" : ""}`}
      onClick={(e) => e.stopPropagation()}
      title={selected ? "선택 해제" : "문서 포함 대상으로 선택"}
    >
      <input
        type="checkbox"
        checked={!!selected}
        onChange={() => onToggleSelect?.()}
      />
    </label>
  ) : null;

  if (role === "user") {
    const showAttachments = attachments && attachments.length > 0;
    return (
      <div className="bubble-row user-row">
        {selectCheckbox}
        <div className="bubble user">
          {showAttachments && (
            <div className="bubble-attachments">
              {attachments!.map((a, i) => (
                <span key={i} className="bubble-attachment" title={a.filename}>
                  <span className="bubble-attachment-icon" aria-hidden="true">
                    {bubbleAttachmentIcon(a.filename, a.kind)}
                  </span>
                  <span className="bubble-attachment-name">
                    {bubbleAttachmentBasename(a.filename)}
                  </span>
                </span>
              ))}
            </div>
          )}
          {content}
          {streaming && <span className="cursor">▍</span>}
        </div>
        {!streaming && content && <CopyButton text={content} />}
      </div>
    );
  }
  return (
    <div className="bubble assistant">
      {selectCheckbox}
      <div className="avatar">A</div>
      <div className="body">
        {provider && <div className="bubble-header">{provider}</div>}
        <div className="content">
          <BubbleContent
            content={content}
            streaming={!!streaming}
            artifactTitlePrefix={artifactTitlePrefix}
          />
        </div>
        {!streaming && content && (
          <div className="bubble-actions">
            <CopyButton text={content} />
          </div>
        )}
      </div>
    </div>
  );
}
