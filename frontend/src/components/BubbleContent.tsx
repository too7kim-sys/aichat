import { useEffect, useState } from "react";
import { MarkdownContent } from "./MarkdownContent";

type Segment =
  | { kind: "normal"; text: string }
  | { kind: "think"; text: string; closed: boolean };

function splitThinking(text: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("<think>", i);
    if (open < 0) {
      const tail = text.slice(i);
      if (tail) out.push({ kind: "normal", text: tail });
      break;
    }
    if (open > i) out.push({ kind: "normal", text: text.slice(i, open) });
    const after = open + "<think>".length;
    const close = text.indexOf("</think>", after);
    if (close < 0) {
      out.push({ kind: "think", text: text.slice(after), closed: false });
      break;
    }
    out.push({ kind: "think", text: text.slice(after, close), closed: true });
    i = close + "</think>".length;
  }
  return out;
}

function ThinkBlock({
  text,
  live,
  showCursor,
}: {
  text: string;
  live: boolean;
  showCursor: boolean;
}) {
  // Start expanded while the model is still emitting reasoning, then
  // auto-collapse once it's done. The user can re-expand any time.
  const [open, setOpen] = useState(live);
  useEffect(() => {
    if (!live) setOpen(false);
  }, [live]);
  return (
    <details
      className={`think-block${live ? " live" : ""}`}
      open={open}
      onToggle={(e) =>
        setOpen((e.currentTarget as HTMLDetailsElement).open)
      }
    >
      <summary>
        <span className="think-icon">🧠</span>
        <span className="think-label">사고 과정</span>
        {live && <span className="think-status">진행중...</span>}
      </summary>
      <div className="think-body">
        {text}
        {showCursor && <span className="cursor">▍</span>}
      </div>
    </details>
  );
}

interface Props {
  content: string;
  streaming: boolean;
  artifactTitlePrefix?: string;
}

export function BubbleContent({
  content,
  streaming,
  artifactTitlePrefix,
}: Props) {
  const segments = splitThinking(content);
  if (segments.length === 0) {
    return streaming ? <span className="cursor">▍</span> : null;
  }
  const lastIdx = segments.length - 1;
  return (
    <>
      {segments.map((seg, i) => {
        const isLast = i === lastIdx;
        if (seg.kind === "think") {
          return (
            <ThinkBlock
              key={i}
              text={seg.text}
              live={streaming && !seg.closed}
              showCursor={streaming && isLast && !seg.closed}
            />
          );
        }
        if (streaming) {
          return (
            <span key={i} className="stream-text">
              {seg.text}
              {isLast && <span className="cursor">▍</span>}
            </span>
          );
        }
        return (
          <MarkdownContent
            key={i}
            content={seg.text}
            artifactTitlePrefix={artifactTitlePrefix}
          />
        );
      })}
    </>
  );
}
