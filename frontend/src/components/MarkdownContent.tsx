import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useArtifacts } from "../artifact/ArtifactContext";

interface Props {
  content: string;
  /** Optional title for artifacts spawned from this content (e.g., turn index). */
  artifactTitlePrefix?: string;
}

function CodeCopy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button type="button" className="code-copy" onClick={copy}>
      {copied ? "✓ 복사됨" : "복사"}
    </button>
  );
}

// Match the first-line file marker the LLM is asked to emit:
//   # file: src/foo.py        (#, --, ;)
//   // file: src/foo.ts       (//)
//   <!-- file: index.html --> (HTML comment)
const FILE_MARKER_RE =
  /^\s*(?:\/\/|#|--|;|<!--)\s*file\s*:\s*([^\s][^\n]*?)\s*(?:-->)?\s*$/i;

function detectFileMarker(
  code: string
): { path: string; body: string } | null {
  const nl = code.indexOf("\n");
  const first = nl >= 0 ? code.slice(0, nl) : code;
  const m = first.match(FILE_MARKER_RE);
  if (!m) return null;
  const rawPath = m[1].trim();
  // Strip surrounding quotes/backticks if the model wrapped the path.
  const path = rawPath.replace(/^['"`]|['"`]$/g, "");
  if (!path) return null;
  const body = nl >= 0 ? code.slice(nl + 1) : "";
  return { path, body };
}

// The path string here comes from a marker the LLM wrote, so we have
// to assume it might contain anything — control chars, NULs, ".."
// padding, very long names. Strip path separators (browsers ignore
// directories in `download` anyway), drop any character outside a
// safe Unicode letter/digit/. _ - set, cap at 128 chars, and fall
// back to a sensible default if there's nothing left.
function sanitizeBasename(fullPath: string): string {
  const raw = fullPath.split(/[\\/]/).pop() ?? "";
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[^\p{L}\p{N}._\-]/gu, "_")
    .replace(/^\.+/, "")
    .slice(0, 128);
  return cleaned || "download.txt";
}

function downloadAsFile(text: string, fullPath: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = sanitizeBasename(fullPath);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function FileDownload({ path, body }: { path: string; body: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`code-download${done ? " done" : ""}`}
      onClick={() => {
        downloadAsFile(body, path);
        setDone(true);
        window.setTimeout(() => setDone(false), 1500);
      }}
      title={`${path} 다운로드`}
    >
      {done ? "✓ 저장됨" : "💾 다운로드"}
    </button>
  );
}

function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  // Same allowlist as react-markdown's default URI sanitizer.
  if (/^(https?:|mailto:|tel:|#|\/|\.)/i.test(trimmed)) return trimmed;
  return undefined;
}

function extractText(node: ReactNode): string {
  if (node == null || node === false) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    const props = (node as { props: { children?: ReactNode } }).props;
    return extractText(props.children);
  }
  return "";
}

export function MarkdownContent({ content, artifactTitlePrefix }: Props) {
  const artifacts = useArtifacts();

  function openInPanel(code: string, lang: string) {
    artifacts.push({
      title: `${artifactTitlePrefix ? artifactTitlePrefix + " - " : ""}${lang || "code"}`,
      language: lang || "plaintext",
      code,
    });
  }

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a({ node: _n, children, href, ...rest }) {
            // Only allow http(s) / mailto / relative links. Strip
            // javascript:, data:, vbscript: etc.
            const safe = safeHref(href);
            return (
              <a
                href={safe}
                target="_blank"
                rel="noopener noreferrer"
                {...rest}
              >
                {children}
              </a>
            );
          },
          pre({ node: _n, children, ...rest }) {
            const text = extractText(children).replace(/\n$/, "");
            let lang = "";
            const codeChild = (Array.isArray(children) ? children[0] : children) as
              | { props?: { className?: string } }
              | undefined;
            const cls = codeChild?.props?.className ?? "";
            const m = /language-([\w+-]+)/.exec(cls);
            if (m) lang = m[1];
            const file = detectFileMarker(text);
            return (
              <div className={`code-block${file ? " has-file" : ""}`}>
                <div className="code-header">
                  <span className="code-lang">{lang || "text"}</span>
                  {file && (
                    <span className="code-file-path" title={file.path}>
                      📄 {file.path}
                    </span>
                  )}
                  <div className="code-header-actions">
                    {file && <FileDownload path={file.path} body={file.body} />}
                    <button
                      type="button"
                      className="code-copy"
                      onClick={() => openInPanel(text, lang)}
                      title="우측 사이드 패널의 에디터에서 열기"
                    >
                      사이드에서 열기
                    </button>
                    <CodeCopy text={text} />
                  </div>
                </div>
                <pre {...rest}>{children}</pre>
              </div>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
