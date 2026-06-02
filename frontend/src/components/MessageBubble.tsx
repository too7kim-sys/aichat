import { useState } from "react";
import { BubbleContent } from "./BubbleContent";

interface Props {
  role: "user" | "assistant";
  provider?: string | null;
  content: string;
  streaming?: boolean;
  artifactTitlePrefix?: string;
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
}: Props) {
  if (role === "user") {
    return (
      <div className="bubble-row user-row">
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
