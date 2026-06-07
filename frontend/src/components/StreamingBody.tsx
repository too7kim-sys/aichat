/** During streaming, replace ``` code fences in the assistant's
 *  text with a compact one-line progress indicator instead of
 *  flashing every generated line into the bubble. Closed fences
 *  read as "✓ {lang} {N}줄", an unclosed fence (= the code the
 *  model is actively writing) shows a spinner + live line count.
 *  After the stream ends the bubble re-renders through
 *  MarkdownContent, which restores the full collapsible code
 *  block UI — so the user sees the finished code there, not here.
 */
import type { ReactNode } from "react";

type Seg =
  | { kind: "text"; text: string }
  | { kind: "code-done"; lang: string; lines: number }
  | { kind: "code-live"; lang: string; lines: number };

/** Split a streaming buffer into text + code-fence segments.
 *  Robust to triple-backtick fences with or without a language tag;
 *  the closing fence must sit on its own line ("^```$") which is
 *  what every model we route to actually emits. */
function parseStreamingBody(body: string): Seg[] {
  const out: Seg[] = [];
  const lines = body.split("\n");
  let i = 0;
  let textBuf: string[] = [];

  function flushText() {
    if (textBuf.length === 0) return;
    out.push({ kind: "text", text: textBuf.join("\n") });
    textBuf = [];
  }

  while (i < lines.length) {
    const line = lines[i];
    const openMatch = /^```([A-Za-z0-9_+\-./]*)\s*$/.exec(line);
    if (!openMatch) {
      textBuf.push(line);
      i += 1;
      continue;
    }
    const lang = openMatch[1] || "";
    // Look for the closing fence on its own line.
    let j = i + 1;
    while (j < lines.length && lines[j] !== "```") {
      j += 1;
    }
    flushText();
    if (j < lines.length) {
      // Closed fence — j is the closing line, j-i-1 code lines.
      out.push({ kind: "code-done", lang, lines: j - i - 1 });
      i = j + 1;
    } else {
      // Unclosed fence — currently being streamed.
      out.push({ kind: "code-live", lang, lines: lines.length - i - 1 });
      i = lines.length;
    }
  }
  flushText();
  return out;
}

export function StreamingBody({
  body,
  showCursor,
}: {
  body: string;
  /** Whether to draw the blinking cursor at the very end. The caller
   *  passes true only for the last text bubble — the rest of the
   *  stream renders as already-completed segments. */
  showCursor: boolean;
}) {
  const segs = parseStreamingBody(body);
  if (segs.length === 0) {
    return showCursor ? <span className="cursor">▍</span> : null;
  }
  const lastIdx = segs.length - 1;
  return (
    <>
      {segs.map((s, idx): ReactNode => {
        const isLast = idx === lastIdx;
        if (s.kind === "text") {
          return (
            <span key={idx}>
              {s.text}
              {isLast && showCursor && <span className="cursor">▍</span>}
            </span>
          );
        }
        if (s.kind === "code-live") {
          return (
            <div key={idx} className="code-progress live">
              <span className="code-progress-spinner" aria-hidden />
              <span>
                코드 생성 중
                {s.lang && (
                  <>
                    {" "}
                    (<code>{s.lang}</code>)
                  </>
                )}{" "}
                · {s.lines.toLocaleString()}줄
              </span>
            </div>
          );
        }
        // code-done — finished code block from earlier in the stream
        return (
          <div key={idx} className="code-progress done">
            <span className="code-progress-check" aria-hidden>
              ✓
            </span>
            <span>
              코드 작성 완료
              {s.lang && (
                <>
                  {" "}
                  (<code>{s.lang}</code>)
                </>
              )}{" "}
              · {s.lines.toLocaleString()}줄
            </span>
          </div>
        );
      })}
    </>
  );
}
