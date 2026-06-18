import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { api } from "../api/client";
import { errorToast } from "../lib/toast";
import { copyText } from "../lib/clipboard";
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
    const ok = await copyText(text, "아래 코드를 복사하세요");
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
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

/** "Finalize" action that branches on the workspace's source type so
 *  the same button does the right thing in each case:
 *    - git clone   → apply + git commit + git push  ("Git에 반영")
 *    - local folder → apply + browser download       ("저장 + 다운로드")
 *  Only rendered when the chat is bound to a workspace — without one
 *  there's nowhere to apply / commit. */
function FileFinalize({ path, body }: { path: string; body: string }) {
  const { workspaceId, sourceType, onPatchApplied } = useChatWorkspace();
  const [state, setState] = useState<
    "idle" | "busy" | "done" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  // Cap the success-state hold time so the row settles back to a
  // usable button after a regen / second attempt.
  const DONE_HOLD_MS = 2200;

  if (!workspaceId || !sourceType) return null;

  async function run() {
    if (!workspaceId) return;
    setState("busy");
    setError(null);
    try {
      // Apply first — if the server rejects (path traversal,
      // collision with .git, …) we don't go any further.
      await api.applyWorkspaceFile(workspaceId, path, body);
      if (sourceType === "git") {
        // Stage + commit + push in one round trip. The message is
        // a sensible default; users who want a custom message use
        // the standalone Commit panel later.
        const result = await api.commitWorkspace(workspaceId, {
          message: `AI generated: ${path}`,
          paths: [path],
          push: true,
        });
        if (!result.commit.committed) {
          // "Nothing to commit" lands here when the apply produced
          // an identical file — surface that as a soft success
          // rather than an error.
          setState("done");
          window.setTimeout(() => setState("idle"), DONE_HOLD_MS);
          onPatchApplied?.();
          return;
        }
        if (result.push && !result.push.pushed) {
          setError(
            `커밋은 됐지만 푸시 실패: ${result.push.error ?? "원인 불명"}`,
          );
          setState("error");
          window.setTimeout(() => setState("idle"), 3500);
          onPatchApplied?.();
          return;
        }
      } else {
        // local-folder source — file is already on disk where the
        // user wanted it (the registered path), so the "download"
        // here is a regular browser download in case they're on a
        // different machine than the backend.
        downloadAsFile(body, path);
      }
      onPatchApplied?.();
      setState("done");
      window.setTimeout(() => setState("idle"), DONE_HOLD_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
      window.setTimeout(() => setState("idle"), 3500);
    }
  }

  const isGit = sourceType === "git";
  const idleLabel = isGit ? "🚀 저장 + Git 반영" : "📦 저장 + 다운로드";
  const busyLabel = isGit ? "⏳ commit + push…" : "⏳ 저장 중…";
  const doneLabel = isGit
    ? "✓ commit + push 완료"
    : "✓ 저장 + 다운로드 완료";
  const idleTitle = isGit
    ? `${path}를 워크스페이스에 저장한 뒤 git commit + push`
    : `${path}를 워크스페이스 폴더에 저장한 뒤 브라우저로 다운로드`;

  if (state === "busy") {
    return (
      <button type="button" className="code-apply busy" disabled>
        {busyLabel}
      </button>
    );
  }
  if (state === "done") {
    return (
      <button type="button" className="code-apply done" disabled>
        {doneLabel}
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
    <span style={{ display: "inline-flex", gap: 6 }}>
      <PreviewButton path={path} body={body} />
      <button
        type="button"
        className="code-apply"
        onClick={run}
        title={idleTitle}
      >
        {idleLabel}
      </button>
    </span>
  );
}

/** "미리보기" — 디스크에 쓰기 전 LLM 결과물 vs 기존 파일의 unified diff
 *  를 모달로 보여준다. 사용자가 안에서 "적용" 을 누르면 applyWorkspaceFile
 *  까지 한 번에. */
function PreviewButton({ path, body }: { path: string; body: string }) {
  const { workspaceId, onPatchApplied } = useChatWorkspace();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.previewWorkspaceFile>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  async function openPreview() {
    if (!workspaceId) return;
    setOpen(true);
    setLoading(true);
    setErr(null);
    try {
      const r = await api.previewWorkspaceFile(workspaceId, path, body);
      setData(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function applyNow() {
    if (!workspaceId) return;
    setApplying(true);
    try {
      await api.applyWorkspaceFile(workspaceId, path, body);
      onPatchApplied?.();
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  if (!workspaceId) return null;
  return (
    <>
      <button
        type="button"
        className="code-apply secondary"
        onClick={openPreview}
        title={`${path} 변경 사항 미리보기 (적용 전 확인)`}
      >
        👁 미리보기
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div
            className="modal patch-preview-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <h3>변경 미리보기</h3>
              <code className="patch-preview-path">{path}</code>
              <button
                type="button"
                className="modal-close"
                onClick={() => setOpen(false)}
                aria-label="닫기"
              >×</button>
            </header>
            <div className="patch-preview-body">
              {loading ? (
                <div className="patch-preview-empty">불러오는 중…</div>
              ) : err ? (
                <div className="patch-preview-empty patch-preview-err">⚠ {err}</div>
              ) : data?.unchanged ? (
                <div className="patch-preview-empty">기존 파일과 동일합니다 — 적용해도 변경 없음.</div>
              ) : data?.added ? (
                <>
                  <div className="patch-preview-meta">새 파일 · {data.new_lines} 줄</div>
                  <pre className="patch-preview-diff added">{body}</pre>
                </>
              ) : data ? (
                <>
                  <div className="patch-preview-meta">
                    수정 · {data.old_lines} 줄 → {data.new_lines} 줄
                  </div>
                  <UnifiedDiffView diff={data.diff} />
                </>
              ) : null}
            </div>
            <footer>
              <button
                type="button"
                className="pm-btn-secondary"
                onClick={() => setOpen(false)}
              >
                닫기
              </button>
              <button
                type="button"
                className="pm-btn-primary"
                onClick={applyNow}
                disabled={applying || loading || !!err || !!data?.unchanged}
              >
                {applying ? "적용 중…" : "적용"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

function UnifiedDiffView({ diff }: { diff: string }) {
  // unified diff 한 줄씩 색칠 — +/-/@/공백.
  const lines = diff.split("\n");
  return (
    <pre className="patch-preview-diff">
      {lines.map((line, i) => {
        let cls = "";
        if (line.startsWith("+++") || line.startsWith("---")) cls = "head";
        else if (line.startsWith("@@")) cls = "hunk";
        else if (line.startsWith("+")) cls = "ins";
        else if (line.startsWith("-")) cls = "del";
        return (
          <span key={i} className={cls}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

/** AI 가 `# file:` 마커를 빼먹은 코드 블록도 저장할 수 있게 — 사용자가
 *  경로를 입력하면 그 자리에 저장.  code_focused 가 아닌 평범한 채팅의
 *  스니펫에도 노출되지만, 워크스페이스가 없으면 null. */
function FileSaveAsPrompt({ body, language }: { body: string; language: string }) {
  const { workspaceId, onPatchApplied } = useChatWorkspace();
  const [busy, setBusy] = useState(false);
  if (!workspaceId) return null;
  if (!body || body.length < 10) return null;

  async function save() {
    if (!workspaceId) return;
    // 언어 별칭 → 확장자 + 기본 경로 매핑.  LLM 은 보통 `py`, `ts`,
    // `js`, `sh` 같은 짧은 alias 를 쓰는데 풀네임만 매칭하면 전부
    // .txt 로 떨어져 사용성이 망가짐.  소문자로 정규화 후 단일 표.
    const lang = (language || "").toLowerCase().trim();
    // Java 는 전자정부프레임웍(eGovFramework) 패턴이 압도적이라 본문을
    // 보고 정확한 디렉터리를 추론.  단서가 없으면 일반 Spring fallback.
    const guessJavaPath = (): string | null => {
      if (lang !== "java") return null;
      // 1) package 선언 우선 — 가장 정확.
      const pkg = body.match(/^\s*package\s+([\w.]+)\s*;/m);
      const cls = body.match(/(?:class|interface|enum)\s+(\w+)/);
      const className = cls ? cls[1] : "NewFile";
      if (pkg) {
        const rel = pkg[1].replace(/\./g, "/");
        return `src/main/java/${rel}/${className}.java`;
      }
      // 2) eGovFramework 구조 단서 — 베이스 클래스/어노테이션 시그너처.
      const lc = body.toLowerCase();
      const isController = /@controller\b|@restcontroller\b/i.test(body);
      const isService =
        /extends\s+EgovAbstractServiceImpl|@service\b/.test(body);
      const isServiceIface = /interface\s+\w+Service\b/.test(body);
      const isMapper =
        /extends\s+EgovAbstractMapper|@mapper\b|interface\s+\w+Mapper\b/.test(body);
      const isVO = /\bclass\s+\w+VO\b|\bclass\s+\w+DTO\b/.test(body);
      const isEgov = lc.includes("egovframework");
      // feature 추정: 클래스명에서 Controller/ServiceImpl/Service/Mapper/VO 제거.
      const feature = className
        .replace(/(Controller|ServiceImpl|Service|Mapper|VO|DTO)$/, "")
        .toLowerCase() || "sample";
      if (isEgov || isController || isService || isMapper || isVO) {
        const base = `src/main/java/egovframework/sample/${feature}`;
        if (isController) return `${base}/web/${className}.java`;
        if (isService && !isServiceIface) return `${base}/service/impl/${className}.java`;
        if (isServiceIface) return `${base}/service/${className}.java`;
        if (isMapper) return `${base}/service/impl/${className}.java`;
        if (isVO) return `${base}/service/${className}.java`;
        return `${base}/${className}.java`;
      }
      // 3) 일반 Spring Boot fallback.
      return `src/main/java/com/example/${className}.java`;
    };
    // MyBatis SQL XML / JSP / WebSquare / Nexacro 본문을 보고 분기.
    const guessXmlPath = (): string | null => {
      // 1) 넥사크로 — .xfdl 본문은 XML 이지만 fence 가 xml 로 올 수 있음.
      //    헤더에 <FDL> 또는 Form/Components 시그니처가 있으면 넥사크로.
      if (/<FDL\s+version=|<Form\s+id=|class_name=["']\w*Form["']/i.test(body)) {
        // Form id="frm_xxx" 또는 class_name 에서 폼 이름 추출.
        const m =
          body.match(/<Form\s+id=["']([^"']+)["']/) ||
          body.match(/class_name=["']([^"']+)["']/);
        const name = m ? m[1] : "NewForm";
        return `Base/Form/sample/${name}.xfdl`;
      }
      // 2) 넥사크로 — Application(.xadl) 시그니처.
      if (/<ADL\s+version=|<Application\s+id=/i.test(body)) {
        const m = body.match(/<Application\s+id=["']([^"']+)["']/);
        const name = m ? m[1] : "NewApp";
        return `Base/Application/${name}.xadl`;
      }
      // 3) 웹스퀘어 — w2: 네임스페이스 또는 inswave URL 시그니처.
      if (
        /xmlns:w2=["']http:\/\/www\.inswave\.com\/websquare/i.test(body) ||
        /<w2:engine|<w2:group|<w2:gridView|<w2:input/i.test(body)
      ) {
        // <html id="..."> 에서 페이지 이름 추출 시도.
        const m = body.match(/<html[^>]*\bid=["']([^"']+)["']/);
        const name = m ? m[1] : "newPage";
        return `src/main/webapp/ws/sample/${name}.xml`;
      }
      // 4) MyBatis SQL XML.
      if (lang === "xml" || lang === "") {
        if (/<mapper\s+namespace=|<sqlMap\s+namespace=/i.test(body)) {
          const ns = body.match(/namespace=["']([^"']+)["']/);
          const feature = ns ? ns[1].split(".").pop() || "sample" : "sample";
          return `src/main/resources/egovframework/sqlmap/sample/${feature}_SQL.xml`;
        }
      }
      return null;
    };
    // 넥사크로 JS / WebSquare JS 분기 — .xjs / .js 본문 단서.
    const guessNexacroJsPath = (): string | null => {
      if (!/^[a-z]*j(s|avascript)$/i.test(lang) && lang !== "xjs") return null;
      // Nexacro 전용 호출 API 단서.
      if (/nexacro\.|nexa\.Set|application\.openForm|gfn_/i.test(body)) {
        return "Base/Js/CommonScript.xjs";
      }
      // WebSquare 클라이언트 단서.
      if (/WebSquare\.|wframe\.|w2_button|w2\.scwin\b/i.test(body)) {
        return "src/main/webapp/ws/sample/newPage.js";
      }
      return null;
    };
    const guessJspPath = (): string | null => {
      if (lang !== "jsp" && lang !== "html") return null;
      if (/<%@\s*page|<c:|<form:/i.test(body)) {
        return `src/main/webapp/WEB-INF/jsp/egovframework/sample/sampleList.jsp`;
      }
      return null;
    };
    const LANG_DEFAULTS: Record<string, string> = {
      py: "src/new_file.py",
      python: "src/new_file.py",
      ts: "src/new_file.ts",
      tsx: "src/new_file.tsx",
      typescript: "src/new_file.ts",
      js: "src/new_file.js",
      jsx: "src/new_file.jsx",
      mjs: "src/new_file.mjs",
      cjs: "src/new_file.cjs",
      javascript: "src/new_file.js",
      // Java 기본 = 전자정부프레임웍 (eGovFramework) 표준.  실제로는
      // guessJavaPath() 가 package 선언이나 어노테이션을 보고 정확한
      // 디렉터리(web/service/service.impl)로 분류해 이걸 덮어씀.
      java: "src/main/java/egovframework/sample/sample/web/NewFile.java",
      jsp: "src/main/webapp/WEB-INF/jsp/egovframework/sample/sampleList.jsp",
      // 넥사크로 (Nexacro / TOBESOFT) — 별도 fence (`xfdl` 등) 일 때 직진.
      xfdl: "Base/Form/sample/NewForm.xfdl",
      xadl: "Base/Application/NewApp.xadl",
      xjs: "Base/Js/CommonScript.xjs",
      xprj: "NewProject.xprj",
      xtdl: "Base/TypeDef/typedef.xtdl",
      xcss: "Base/Theme/default/style.xcss",
      nexacro: "Base/Form/sample/NewForm.xfdl",
      // 웹스퀘어 (WebSquare / 인스웨이브) — fence 가 `websquare`/`wsq` 인 경우.
      websquare: "src/main/webapp/ws/sample/newPage.xml",
      wsq: "src/main/webapp/ws/sample/newPage.xml",
      kt: "src/main/kotlin/NewFile.kt",
      kotlin: "src/main/kotlin/NewFile.kt",
      go: "cmd/main/main.go",
      golang: "cmd/main/main.go",
      rs: "src/main.rs",
      rust: "src/main.rs",
      c: "src/new_file.c",
      h: "src/new_file.h",
      cpp: "src/new_file.cpp",
      "c++": "src/new_file.cpp",
      cxx: "src/new_file.cpp",
      cc: "src/new_file.cpp",
      hpp: "src/new_file.hpp",
      cs: "src/NewFile.cs",
      csharp: "src/NewFile.cs",
      rb: "lib/new_file.rb",
      ruby: "lib/new_file.rb",
      php: "src/new_file.php",
      swift: "Sources/NewFile.swift",
      scala: "src/main/scala/NewFile.scala",
      sh: "scripts/new_file.sh",
      bash: "scripts/new_file.sh",
      shell: "scripts/new_file.sh",
      zsh: "scripts/new_file.sh",
      sql: "sql/new_file.sql",
      html: "public/new_file.html",
      htm: "public/new_file.html",
      css: "src/styles/new_file.css",
      scss: "src/styles/new_file.scss",
      sass: "src/styles/new_file.sass",
      less: "src/styles/new_file.less",
      json: "config/new_file.json",
      yaml: "config/new_file.yaml",
      yml: "config/new_file.yml",
      toml: "config/new_file.toml",
      ini: "config/new_file.ini",
      env: ".env.new",
      md: "docs/new_file.md",
      markdown: "docs/new_file.md",
      rst: "docs/new_file.rst",
      xml: "config/new_file.xml",
      vue: "src/components/NewComponent.vue",
      svelte: "src/components/NewComponent.svelte",
      dockerfile: "Dockerfile.new",
      makefile: "Makefile.new",
      tf: "infra/new_file.tf",
      terraform: "infra/new_file.tf",
      hcl: "infra/new_file.hcl",
    };
    const defaultName =
      guessJavaPath() ||
      guessXmlPath() ||
      guessJspPath() ||
      guessNexacroJsPath() ||
      LANG_DEFAULTS[lang] ||
      `src/new_file.${lang || "txt"}`;
    const path = window.prompt(
      "어느 경로에 저장할까요?  (워크스페이스 상대 경로)",
      defaultName,
    );
    if (!path || !path.trim()) return;
    setBusy(true);
    try {
      await api.applyWorkspaceFile(workspaceId, path.trim(), body);
      onPatchApplied?.();
      window.dispatchEvent(new CustomEvent("ws:tree-refresh"));
      window.dispatchEvent(
        new CustomEvent("chat:toast", {
          detail: { text: `📂 ${path.trim()} 저장됨` },
        }),
      );
    } catch (e) {
      errorToast("저장 실패", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="code-apply"
      onClick={save}
      disabled={busy}
      title="이 코드 블록을 워크스페이스에 저장 (경로 직접 지정)"
    >
      {busy ? "⏳ 저장…" : "📂 저장…"}
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
          {file && <FileFinalize path={file.path} body={file.body} />}
          {!file && <FileSaveAsPrompt body={text} language={lang} />}
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
            // ```ask {...} ``` 블록은 선택지 카드로 렌더 — 코드 블록
            // 자체는 숨김. JSON 파싱 실패 시 일반 코드로 fallback.
            if (lang === "ask") {
              const parsed = parseAskBlock(text);
              if (parsed) return <AskBlock {...parsed} />;
            }
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

/**
 * 모델이 모호한 질문에 추측 대신 ```ask {…} ``` 코드 블록으로 다시
 * 물을 때, 그 본문을 파싱해 카드로 렌더한다. 사용자가 버튼을 누르면
 * "chat:choice-picked" 커스텀 이벤트를 띄워 ChatPanel 이 잡고 다음
 * 메시지로 그 텍스트를 보낸다.
 */
type AskBlockData = { question: string; choices: string[] };

function parseAskBlock(text: string): AskBlockData | null {
  try {
    const obj = JSON.parse(text);
    if (typeof obj !== "object" || obj === null) return null;
    const q = typeof obj.question === "string" ? obj.question.trim() : "";
    const c = Array.isArray(obj.choices)
      ? obj.choices
          .map((x: unknown) => (typeof x === "string" ? x.trim() : ""))
          .filter((s: string) => s.length > 0)
      : [];
    if (!q || c.length < 2 || c.length > 6) return null;
    return { question: q, choices: c.slice(0, 6) };
  } catch {
    return null;
  }
}

function AskBlock({ question, choices }: AskBlockData) {
  const [pickedIdx, setPickedIdx] = useState<number | null>(null);

  function pick(idx: number) {
    if (pickedIdx !== null) return;
    setPickedIdx(idx);
    window.dispatchEvent(
      new CustomEvent("chat:choice-picked", {
        detail: { text: choices[idx] },
      }),
    );
  }

  return (
    <div className="ask-block" role="group" aria-label="선택지">
      <div className="ask-block-q">
        <span className="ask-block-icon" aria-hidden>❓</span>
        <span>{question}</span>
      </div>
      <div className="ask-block-choices">
        {choices.map((c, i) => (
          <button
            key={i}
            type="button"
            className={`ask-block-choice${pickedIdx === i ? " picked" : ""}`}
            onClick={() => pick(i)}
            disabled={pickedIdx !== null}
            title="이 선택지로 다음 메시지를 보냅니다"
          >
            <span className="ask-block-choice-label">{String.fromCharCode(65 + i)}</span>
            <span className="ask-block-choice-text">{c}</span>
          </button>
        ))}
      </div>
      {pickedIdx !== null && (
        <div className="ask-block-hint">전송 중…</div>
      )}
    </div>
  );
}
