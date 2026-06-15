import { useEffect, useState } from "react";
import { FindingsRender, splitFindings } from "./Findings";
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

// PII 마스킹 (#43) — 사용자가 마이페이지 / UserMenu 에서 켜면
// localStorage 에 "1" 로 저장.  display-time 에 본문에서 전화번호 ·
// 주민번호 · 이메일 · 카드 번호 후보를 가림.  서버 저장은 그대로
// (요청 시 원본 복원 가능).
function maskPii(text: string): string {
  // 주민번호 (YYMMDD-NXXXXXX)
  text = text.replace(/\b(\d{6})[-]\d{7}\b/g, "$1-*******");
  // 휴대전화 (010-XXXX-XXXX 또는 010XXXXXXXX, 02-XXX-XXXX 등)
  text = text.replace(
    /\b(01[016789])[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g,
    (_m, p) => `${p}-****-****`,
  );
  text = text.replace(
    /\b0(2|[3-9]\d)[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g,
    "0**-****-****",
  );
  // 이메일 (사용자명 부분만 가림)
  text = text.replace(
    /\b([A-Za-z0-9._%+-]{1,3})[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    "$1***@$2",
  );
  // 신용카드 후보 — 4-4-4-4 자리 숫자 그룹.
  text = text.replace(
    /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    "****-****-****-****",
  );
  return text;
}

export function BubbleContent({
  content,
  streaming,
  artifactTitlePrefix,
}: Props) {
  const piiOn =
    typeof window !== "undefined" &&
    localStorage.getItem("chat:pii-mask") === "1";
  const safeContent = piiOn ? maskPii(content) : content;
  const segments = splitThinking(safeContent);
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
        const findings = splitFindings(seg.text);
        return (
          <FindingsRender
            key={i}
            segments={findings}
            streaming={streaming}
            isLastInBubble={isLast}
            artifactTitlePrefix={artifactTitlePrefix}
          />
        );
      })}
    </>
  );
}
