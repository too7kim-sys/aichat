import { useEffect, useState } from "react";
import { MarkdownContent } from "./MarkdownContent";

// LLM is asked to emit each finding as:
//   ### [HIGH] short title — path/to/file.ext:42
// followed by free-form markdown (problem / risk / fix). We slice the
// text on these headings and render each block as a collapsible card.
//
// The regex tolerates extra whitespace and accepts ":?" when the model
// can't pin down a line. Severity is restricted to a short whitelist
// so random "###" headings don't get hijacked.
const FINDING_HEADING_RE =
  /^###\s*\[(HIGH|MEDIUM|LOW|INFO)\]\s+(.+?)\s+(?:—|--|-)\s+([^\s][^\n]*?)\s*$/im;

const FINDING_HEADING_RE_G =
  /^###\s*\[(HIGH|MEDIUM|LOW|INFO)\]\s+(.+?)\s+(?:—|--|-)\s+([^\s][^\n]*?)\s*$/gim;

export type Severity = "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type FindingSegment =
  | { kind: "text"; body: string }
  | {
      kind: "finding";
      severity: Severity;
      title: string;
      location: string;
      body: string;
      closed: boolean; // false = still streaming the body (last segment)
    };

export function hasFinding(text: string): boolean {
  return FINDING_HEADING_RE.test(text);
}

export function splitFindings(text: string): FindingSegment[] {
  const segs: FindingSegment[] = [];
  const matches: Array<{ idx: number; len: number; m: RegExpExecArray }> = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(FINDING_HEADING_RE_G);
  while ((m = re.exec(text)) !== null) {
    matches.push({ idx: m.index, len: m[0].length, m });
  }
  if (matches.length === 0) {
    return [{ kind: "text", body: text }];
  }
  // Leading text before the first finding.
  if (matches[0].idx > 0) {
    segs.push({ kind: "text", body: text.slice(0, matches[0].idx) });
  }
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const bodyStart = cur.idx + cur.len;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].idx : text.length;
    const body = text.slice(bodyStart, bodyEnd).replace(/^\n+/, "").replace(/\n+$/, "");
    segs.push({
      kind: "finding",
      severity: cur.m[1].toUpperCase() as Severity,
      title: cur.m[2].trim(),
      location: cur.m[3].trim(),
      body,
      closed: i + 1 < matches.length, // last finding stays "open" until next heading
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
  // Active streaming card auto-expands; completed cards default to
  // collapsed (the list view). User can toggle freely afterwards.
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
