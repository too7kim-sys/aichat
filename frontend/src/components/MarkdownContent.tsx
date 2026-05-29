import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

interface Props {
  content: string;
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

export function MarkdownContent({ content }: Props) {
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
            // Try to find language from the inner <code class="language-xxx">
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
                  <CodeCopy text={text} />
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
