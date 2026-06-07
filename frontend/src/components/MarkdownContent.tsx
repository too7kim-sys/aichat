import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { api } from "../api/client";
import { useArtifacts } from "../artifact/ArtifactContext";
import { useChatWorkspace } from "../state/ChatWorkspaceContext";

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
      title={`${path} 다운로드 (브라우저 기본 다운로드 폴더)`}
    >
      {done ? "✓ 저장됨" : "💾 다운로드"}
    </button>
  );
}

/** Combined action: write the file into the workspace clone on the
 *  backend AND trigger the browser download in one click. Only
 *  rendered when the chat is bound to a workspace — without one
 *  there's nowhere to apply, so the standalone Download button is
 *  enough. Lets the user say "다운받게 해줘" and walk away with both
 *  the file on their machine and the workspace folder updated. */
function FileSaveAndDownload({
  path,
  body,
}: {
  path: string;
  body: string;
}) {
  const { workspaceId, onPatchApplied } = useChatWorkspace();
  const [state, setState] = useState<
    "idle" | "busy" | "done" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  if (!workspaceId) return null;

  async function run() {
    if (!workspaceId) return;
    setState("busy");
    setError(null);
    try {
      // Apply first — if the server rejects (path traversal, etc.)
      // we'd rather not hand the user a file that didn't actually
      // make it into the workspace.
      await api.applyWorkspaceFile(workspaceId, path, body);
      downloadAsFile(body, path);
      onPatchApplied?.();
      setState("done");
      window.setTimeout(() => setState("idle"), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
      window.setTimeout(() => setState("idle"), 3500);
    }
  }

  if (state === "busy") {
    return (
      <button type="button" className="code-apply busy" disabled>
        ⏳ 저장 중…
      </button>
    );
  }
  if (state === "done") {
    return (
      <button type="button" className="code-apply done" disabled>
        ✓ 저장 + 다운로드 완료
      </button>
    );
  }
  if (state === "error") {
    return (
      <button
        type="button"
        className="code-apply err"
        title={error ?? ""}
        onClick={() => setState("idle")}
      >
        ⚠ 실패
      </button>
    );
  }
  return (
    <button
      type="button"
      className="code-apply"
      onClick={run}
      title={`${path}를 워크스페이스에 저장한 뒤 브라우저로 다운로드`}
    >
      📦 저장 + 다운로드
    </button>
  );
}

/** Push the LLM's `# file: <path>` code block straight into the
 * workspace clone on the server. Only rendered inside chats that are
 * actually bound to a workspace (otherwise there's nowhere to apply
 * the patch). Two confirmation states ("적용?", "✓ 적용됨") give the
 * user a chance to back out before overwriting their file. */
function FileApply({ path, body }: { path: string; body: string }) {
  const { workspaceId, onPatchApplied } = useChatWorkspace();
  const [state, setState] = useState<"idle" | "confirm" | "busy" | "done" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  if (!workspaceId) return null;

  async function apply() {
    if (!workspaceId) return;
    setState("busy");
    setError(null);
    try {
      await api.applyWorkspaceFile(workspaceId, path, body);
      setState("done");
      onPatchApplied?.();
      window.setTimeout(() => setState("idle"), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
      window.setTimeout(() => setState("idle"), 3500);
    }
  }

  if (state === "confirm") {
    return (
      <span className="code-apply-confirm">
        <button
          type="button"
          className="code-apply confirm"
          onClick={apply}
          title={`${path}를 워크스페이스에 덮어쓰기`}
        >
          ✓ 적용
        </button>
        <button
          type="button"
          className="code-apply cancel"
          onClick={() => setState("idle")}
        >
          취소
        </button>
      </span>
    );
  }
  if (state === "busy") {
    return (
      <button type="button" className="code-apply busy" disabled>
        ⏳ 적용 중…
      </button>
    );
  }
  if (state === "done") {
    return (
      <button type="button" className="code-apply done" disabled>
        ✓ 워크스페이스 반영됨
      </button>
    );
  }
  if (state === "error") {
    return (
      <button
        type="button"
        className="code-apply err"
        title={error ?? ""}
        onClick={() => setState("idle")}
      >
        ⚠ 실패
      </button>
    );
  }
  return (
    <button
      type="button"
      className="code-apply"
      onClick={() => setState("confirm")}
      title={`${path}를 워크스페이스에 덮어쓰기`}
    >
      📥 워크스페이스에 적용
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

// Code blocks > this many lines start collapsed by default. Short
// snippets stay inline so common 2-3 line examples don't require a
// click to read.
const _CODE_COLLAPSE_THRESHOLD_LINES = 6;

function CollapsibleCode({
  text,
  lang,
  lineCount,
  file,
  onOpenInPanel,
  preProps,
  children,
}: {
  text: string;
  lang: string;
  lineCount: number;
  file: { path: string; body: string } | null;
  onOpenInPanel: (code: string, lang: string) => void;
  preProps: Record<string, unknown>;
  children: ReactNode;
}) {
  // `# file: <path>` patches are ALWAYS collapsed regardless of size
  // (they're typically whole-file rewrites the user wants to review
  // intentionally, not read line by line in chat). Plain snippets
  // collapse when they're tall enough to dominate the bubble.
  const startCollapsed = !!file || lineCount > _CODE_COLLAPSE_THRESHOLD_LINES;
  const [open, setOpen] = useState(!startCollapsed);
  return (
    <div
      className={`code-block${file ? " has-file" : ""}${open ? " open" : " closed"}`}
    >
      <div className="code-header">
        <button
          type="button"
          className="code-toggle"
          onClick={() => setOpen((v) => !v)}
          title={open ? "코드 숨기기" : "코드 펼치기"}
          aria-expanded={open}
        >
          <span className="code-toggle-chevron" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          <span className="code-lang">{lang || "text"}</span>
          {file && (
            <span className="code-file-path" title={file.path}>
              📄 {file.path}
            </span>
          )}
          {lineCount > 0 && (
            <span className="code-line-count">{lineCount}줄</span>
          )}
        </button>
        <div className="code-header-actions">
          {file && <FileApply path={file.path} body={file.body} />}
          {file && (
            <FileSaveAndDownload path={file.path} body={file.body} />
          )}
          {file && <FileDownload path={file.path} body={file.body} />}
          <button
            type="button"
            className="code-copy"
            onClick={() => onOpenInPanel(text, lang)}
            title="우측 사이드 패널의 에디터에서 열기"
          >
            사이드에서 열기
          </button>
          <CodeCopy text={text} />
        </div>
      </div>
      {open && <pre {...preProps}>{children}</pre>}
    </div>
  );
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
            const lineCount = text ? text.split("\n").length : 0;
            return (
              <CollapsibleCode
                text={text}
                lang={lang}
                lineCount={lineCount}
                file={file}
                onOpenInPanel={openInPanel}
                preProps={rest}
              >
                {children}
              </CollapsibleCode>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
