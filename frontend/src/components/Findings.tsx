import { useEffect, useState } from "react";
import { MarkdownContent } from "./MarkdownContent";

// The LLM is asked to write each finding as:
//   ### [HIGH] short title — path/to/file.ext:42
// but qwen3-coder and similar code-tuned models often drift from the
// exact format (drop brackets, use ":" instead of "—", put severity
// after the title, use #### instead of ###, etc.). Instead of a single
// strict regex we walk line by line, accept any H2-H4 heading that
// contains BOTH a severity keyword AND a path:line locator anywhere
// in the heading text, then strip those out to leave the title.

export type Severity = "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type FindingSegment =
  | { kind: "text"; body: string }
  | {
      kind: "finding";
      severity: Severity;
      title: string;
      location: string;
      body: string;
      closed: boolean; // false = currently streaming the body (last segment)
    };

const HEADING_RE = /^(#{2,4})\s+(.+?)\s*$/;
const SEV_RE = /\b(CRITICAL|HIGH|MEDIUM|MED|LOW|INFO)\b/i;
const LOC_RE =
  /([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+:(?:\d+(?:-\d+)?|\?))/;

interface ParsedHeading {
  severity: Severity;
  title: string;
  location: string;
}

function parseFindingHeading(line: string): ParsedHeading | null {
  const h = HEADING_RE.exec(line);
  if (!h) return null;
  const text = h[2];

  const sevMatch = SEV_RE.exec(text);
  if (!sevMatch) return null;
  let sev = sevMatch[1].toUpperCase();
  if (sev === "MED") sev = "MEDIUM";
  if (sev === "CRITICAL") sev = "HIGH"; // collapse to our 4-bucket palette
  const severity = sev as Severity;

  const locMatch = LOC_RE.exec(text);
  if (!locMatch) return null;
  const location = locMatch[1];

  // Title = original heading text minus the severity token, minus the
  // location token, minus surrounding brackets / punctuation noise.
  let title = text
    .replace(SEV_RE, " ")
    .replace(LOC_RE, " ")
    .replace(/[\[\](){}"`']/g, " ")
    .replace(/[\s\-—:|·.,/]+/g, " ")
    .trim();
  if (!title) title = "(제목 없음)";
  return { severity, title, location };
}

export function hasFinding(text: string): boolean {
  for (const line of text.split("\n")) {
    if (parseFindingHeading(line)) return true;
  }
  return false;
}

export function splitFindings(text: string): FindingSegment[] {
  const lines = text.split("\n");
  // Find indexes of all finding-shaped headings up front so the live
  // streaming case (where the last finding is still growing) can mark
  // the trailing one as not-yet-closed.
  const findingIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (parseFindingHeading(lines[i])) findingIdx.push(i);
  }
  if (findingIdx.length === 0) {
    return [{ kind: "text", body: text }];
  }

  const segs: FindingSegment[] = [];
  // Anything before the first finding heading is leading text.
  if (findingIdx[0] > 0) {
    const leading = lines.slice(0, findingIdx[0]).join("\n");
    if (leading) segs.push({ kind: "text", body: leading });
  }
  for (let i = 0; i < findingIdx.length; i++) {
    const start = findingIdx[i];
    const end = i + 1 < findingIdx.length ? findingIdx[i + 1] : lines.length;
    const parsed = parseFindingHeading(lines[start])!;
    const body = lines
      .slice(start + 1, end)
      .join("\n")
      .replace(/^\n+/, "")
      .replace(/\n+$/, "");
    segs.push({
      kind: "finding",
      severity: parsed.severity,
      title: parsed.title,
      location: parsed.location,
      body,
      // The last finding stays "open" — the model could still be
      // streaming its body. Once another heading appears, this one
      // closes.
      closed: i + 1 < findingIdx.length,
    });
  }
  return segs;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  HIGH: "HIGH",
  MEDIUM: "MED",
  LOW: "LOW",
  INFO: "INFO",
};

function FindingCard({
  severity,
  title,
  location,
  body,
  streaming,
  showCursor,
  artifactTitlePrefix,
}: {
  severity: Severity;
  title: string;
  location: string;
  body: string;
  streaming: boolean;
  showCursor: boolean;
  artifactTitlePrefix?: string;
}) {
  const [open, setOpen] = useState(showCursor);
  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);
  return (
    <details
      className={`finding sev-${severity}${showCursor ? " live" : ""}`}
      open={open}
      onToggle={(e) =>
        setOpen((e.currentTarget as HTMLDetailsElement).open)
      }
    >
      <summary>
        <span className={`finding-badge badge-${severity}`}>
          {SEVERITY_LABEL[severity]}
        </span>
        <span className="finding-title">{title}</span>
        <span className="finding-loc" title={location}>
          {location}
        </span>
        {showCursor && <span className="finding-status">…</span>}
      </summary>
      <div className="finding-body">
        {streaming ? (
          <>
            <span className="finding-stream">{body}</span>
            {showCursor && <span className="cursor">▍</span>}
          </>
        ) : (
          <MarkdownContent
            content={body}
            artifactTitlePrefix={artifactTitlePrefix}
          />
        )}
      </div>
    </details>
  );
}

interface Props {
  segments: FindingSegment[];
  streaming: boolean;
  isLastInBubble: boolean;
  artifactTitlePrefix?: string;
}

export function FindingsRender({
  segments,
  streaming,
  isLastInBubble,
  artifactTitlePrefix,
}: Props) {
  const lastIdx = segments.length - 1;
  return (
    <>
      {segments.map((seg, i) => {
        const isLast = i === lastIdx && isLastInBubble;
        if (seg.kind === "text") {
          if (streaming) {
            return (
              <span key={i} className="stream-text">
                {seg.body}
                {isLast && <span className="cursor">▍</span>}
              </span>
            );
          }
          return (
            <MarkdownContent
              key={i}
              content={seg.body}
              artifactTitlePrefix={artifactTitlePrefix}
            />
          );
        }
        const showCursor = streaming && isLast && !seg.closed;
        return (
          <FindingCard
            key={i}
            severity={seg.severity}
            title={seg.title}
            location={seg.location}
            body={seg.body}
            streaming={streaming}
            showCursor={showCursor}
            artifactTitlePrefix={artifactTitlePrefix}
          />
        );
      })}
    </>
  );
}
