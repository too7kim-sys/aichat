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

function extractText(node: ReactNode): string {
  if (node == null || node === false) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    // @ts-expect-error - ReactNode children traversal
    return extractText(node.props.children);
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
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
                {children}
              </a>
            );
          },
          pre({ node: _n, children, ...rest }) {
            const text = extractText(children).replace(/\n$/, "");
            let lang = "";
            // @ts-expect-error - traverse markdown AST
            const codeChild = Array.isArray(children) ? children[0] : children;
            // @ts-expect-error - props is optional
            const cls = codeChild?.props?.className ?? "";
            const m = /language-([\w+-]+)/.exec(cls);
            if (m) lang = m[1];
            return (
              <div className="code-block">
                <div className="code-header">
                  <span className="code-lang">{lang || "text"}</span>
                  <div className="code-header-actions">
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
