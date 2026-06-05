import { useState } from "react";
import { BubbleContent } from "./BubbleContent";

interface Props {
  role: "user" | "assistant";
  provider?: string | null;
  content: string;
  streaming?: boolean;
  artifactTitlePrefix?: string;
  /** When set, the bubble shows a select checkbox so the user can
   *  pick it for the "export to document" flow. The parent owns the
   *  selection state — the bubble just toggles the bound flag. */
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
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
    return (
      <div className="bubble-row user-row">
        {selectCheckbox}
        <div className="bubble user">
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
