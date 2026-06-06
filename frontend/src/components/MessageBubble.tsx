import { useState } from "react";
import type { AttachmentSummary } from "../api/client";
import { BubbleContent } from "./BubbleContent";
import { IconFileText, IconImage } from "./Icon";

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
  /** Persisted message id — surfaced as a data-message-id attribute
   *  on the bubble root so the global search dialog can scroll the
   *  matching bubble into view after navigating. */
  messageId?: string;
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
  messageId,
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
      <div
        className="bubble-row user-row"
        data-message-id={messageId || undefined}
      >
        {selectCheckbox}
        <div className="bubble user">
          {showAttachments && (
            <div className="bubble-attachments">
              {attachments!.map((a, i) => (
                <span key={i} className="bubble-attachment" title={a.filename}>
                  <span className="bubble-attachment-icon" aria-hidden="true">
                    {a.kind === "image" ? (
                      <IconImage size={13} />
                    ) : (
                      <IconFileText size={13} />
                    )}
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
  const showAssistantAttachments = attachments && attachments.length > 0;
  return (
    <div className="bubble assistant" data-message-id={messageId || undefined}>
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
          {showAssistantAttachments && (
            <div className="bubble-attachments assistant-side">
              {attachments!.map((a, i) => (
                <span key={i} className="bubble-attachment" title={a.filename}>
                  <span className="bubble-attachment-icon" aria-hidden="true">
                    {a.kind === "image" ? (
                      <IconImage size={13} />
                    ) : (
                      <IconFileText size={13} />
                    )}
                  </span>
                  <span className="bubble-attachment-name">
                    {bubbleAttachmentBasename(a.filename)}
                  </span>
                </span>
              ))}
            </div>
          )}
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
