import { useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import { useArtifacts, type Artifact } from "./ArtifactContext";

const PREVIEW_LANGS = new Set(["html", "htm"]);

function normalizeLang(lang: string): string {
  const l = lang.toLowerCase();
  if (l === "js" || l === "javascript") return "javascript";
  if (l === "ts" || l === "typescript") return "typescript";
  if (l === "py") return "python";
  if (l === "shell" || l === "sh") return "shell";
  return l || "plaintext";
}

function buildPreviewSrcDoc(a: Artifact): string | null {
  const lang = a.language.toLowerCase();
  if (PREVIEW_LANGS.has(lang)) return a.code;
  if (lang === "css") {
    return `<!doctype html><html><head><style>${a.code}</style></head><body><div>CSS preview</div></body></html>`;
  }
  if (lang === "javascript" || lang === "js") {
    return `<!doctype html><html><body><pre id="out"></pre><script>
      (function(){
        const out = document.getElementById('out');
        const log = (...a) => { out.textContent += a.map(x => typeof x === 'string' ? x : JSON.stringify(x, null, 2)).join(' ') + '\\n'; };
        const orig = console.log; console.log = (...a) => { orig(...a); log(...a); };
        try { ${a.code} } catch(e) { log('Error:', e.message); }
      })();
    </script></body></html>`;
  }
  return null;
}

export function ArtifactPanel({
  onSendToChat,
}: {
  onSendToChat?: (snippet: string) => void;
}) {
  const { artifacts, activeId, open, setActive, remove, setOpen, updateCode } =
    useArtifacts();
  const [view, setView] = useState<"code" | "preview">("code");

  const active = useMemo(
    () => artifacts.find((a) => a.id === activeId) ?? null,
    [artifacts, activeId]
  );

  if (!open) return null;

  const previewSrc = active ? buildPreviewSrcDoc(active) : null;
  const canPreview = previewSrc !== null;

  function download() {
    if (!active) return;
    const ext = extForLang(active.language);
    const blob = new Blob([active.code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(active.title)}${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copy() {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.code);
    } catch {
      // ignore
    }
  }

  function sendToChat() {
    if (!active || !onSendToChat) return;
    const fence = active.language || "";
    onSendToChat(`\n\n\`\`\`${fence}\n${active.code}\n\`\`\`\n`);
  }

  return (
    <aside className="artifact-panel">
      <div className="artifact-header">
        <div className="artifact-tabs">
          {artifacts.map((a) => (
            <button
              key={a.id}
              className={`artifact-tab ${a.id === activeId ? "active" : ""}`}
              onClick={() => setActive(a.id)}
              title={a.title}
            >
              <span className="artifact-tab-title">{a.title}</span>
              <span
                className="artifact-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(a.id);
                }}
              >
                ×
              </span>
            </button>
          ))}
        </div>
        <button
          className="artifact-close"
          onClick={() => setOpen(false)}
          title="패널 닫기"
        >
          ›
        </button>
      </div>

      {active ? (
        <>
          <div className="artifact-toolbar">
            <div className="artifact-view-toggle">
              <button
                className={view === "code" ? "active" : ""}
                onClick={() => setView("code")}
              >
                코드
              </button>
              <button
                className={view === "preview" ? "active" : ""}
                onClick={() => setView("preview")}
                disabled={!canPreview}
                title={canPreview ? "" : "이 언어는 미리보기 미지원"}
              >
                미리보기
              </button>
            </div>
            <div className="artifact-actions">
              <button onClick={copy} title="클립보드로 복사">복사</button>
              <button onClick={download} title="파일로 저장">다운로드</button>
              {onSendToChat && (
                <button onClick={sendToChat} title="채팅 입력창에 이 코드 삽입">
                  채팅에 보내기
                </button>
              )}
            </div>
          </div>

          <div className="artifact-body">
            {view === "code" ? (
              <Editor
                height="100%"
                language={normalizeLang(active.language)}
                value={active.code}
                theme="vs"
                onChange={(v) => updateCode(active.id, v ?? "")}
                options={{
                  fontSize: 13,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  tabSize: 2,
                  automaticLayout: true,
                }}
              />
            ) : previewSrc !== null ? (
              <iframe
                title="preview"
                className="artifact-preview"
                sandbox="allow-scripts"
                srcDoc={previewSrc}
              />
            ) : (
              <div className="artifact-empty">
                이 언어는 브라우저 미리보기를 지원하지 않습니다.
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="artifact-empty">표시할 코드가 없습니다.</div>
      )}
    </aside>
  );
}

function extForLang(lang: string): string {
  const l = lang.toLowerCase();
  const map: Record<string, string> = {
    python: ".py",
    py: ".py",
    javascript: ".js",
    js: ".js",
    typescript: ".ts",
    ts: ".ts",
    tsx: ".tsx",
    jsx: ".jsx",
    html: ".html",
    css: ".css",
    json: ".json",
    yaml: ".yml",
    yml: ".yml",
    shell: ".sh",
    sh: ".sh",
    bash: ".sh",
    sql: ".sql",
    go: ".go",
    rust: ".rs",
    java: ".java",
    cpp: ".cpp",
    c: ".c",
    md: ".md",
  };
  return map[l] ?? ".txt";
}

function slug(s: string): string {
  return s
    .replace(/[^\w가-힣.\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50) || "artifact";
}
