/** ChatPanel.tsx 가 2423줄로 커져 standalone helpers 만 분리.
 *  순수 함수라 React 의존 없음. */

/** Concise type label rendered below the filename in the attachment
 *  chip. Mirrors Claude's compact "PDF / Word / Image" style instead
 *  of the verbose "ocr · 12,345자" we used to show. */
export function attachmentTypeLabel(filename: string, isImage: boolean): string {
  if (isImage) return "이미지";
  const lower = filename.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  const map: Record<string, string> = {
    pdf: "PDF",
    docx: "Word",
    doc: "Word",
    xlsx: "Excel",
    xls: "Excel",
    pptx: "PowerPoint",
    ppt: "PowerPoint",
    hwpx: "한글",
    hwp: "한글",
    md: "Markdown",
    markdown: "Markdown",
    txt: "텍스트",
    log: "로그",
    csv: "CSV",
    tsv: "TSV",
    json: "JSON",
    yaml: "YAML",
    yml: "YAML",
    xml: "XML",
    html: "HTML",
    htm: "HTML",
    py: "Python",
    js: "JavaScript",
    ts: "TypeScript",
    tsx: "TSX",
    jsx: "JSX",
    java: "Java",
    kt: "Kotlin",
    rs: "Rust",
    go: "Go",
    c: "C",
    cpp: "C++",
    h: "C 헤더",
    hpp: "C++ 헤더",
    cs: "C#",
    rb: "Ruby",
    php: "PHP",
    sh: "Shell",
    sql: "SQL",
    css: "CSS",
    scss: "SCSS",
    toml: "TOML",
    ini: "INI",
    cfg: "Config",
    env: "환경 변수",
  };
  return map[ext] || (ext ? ext.toUpperCase() : "파일");
}

/** Drop the leading workspace/project prefix from a path so the chip
 *  shows the actual file basename. Workspace files come in as
 *  "<workspace>/path/to/file.py"; clipboard pastes as
 *  "clipboard-2026-06-06.png" (no path). */
export function attachmentBasename(filename: string): string {
  const slash = filename.lastIndexOf("/");
  return slash >= 0 ? filename.slice(slash + 1) : filename;
}

/** Extract `<title>` text from an HTML document — used to name the
 *  artifact tab + download filename when the model returned a full
 *  HTML document. Falls back to null when the title is missing or
 *  empty after trim, so the caller can supply a default. */
export function extractHtmlTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (!m) return null;
  const t = m[1].replace(/\s+/g, " ").trim();
  return t || null;
}

/** Pull every ```html``` fenced code block whose body looks like a
 *  complete HTML document (carries a doctype or a <html> tag).
 *  Anything else is treated as a snippet and skipped — auto-opening
 *  every <div> the model echoes back would be noisy. */
export function extractHtmlDocBlocks(content: string): string[] {
  const out: string[] = [];
  const re = /```html\s*\n([\s\S]*?)\n?```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const body = m[1];
    if (/<!doctype\s+html/i.test(body) || /<html[\s>]/i.test(body)) {
      out.push(body);
    }
  }
  return out;
}

/** Parse a merge slash-command from the composer prompt.
 *
 * Accepted forms (case-insensitive on the keywords):
 *   /merge                /병합                 → no title (uses default)
 *   /merge 회의자료       /병합 회의자료        → title = "회의자료"
 *   합쳐줘 / 합쳐 / 합치기 / 병합 / 병합해줘     → no title
 *   회의자료로 병합        회의자료 합치기        → title = "회의자료"
 *   merge / combine                              → no title (EN aliases)
 *
 * Returns `{ matched: false }` for anything else so the normal LLM
 * flow runs. The match is strict — the whole prompt must be the
 * command, otherwise "병합 보고서를 요약해줘" type prompts would be
 * intercepted by accident.
 */
export function parseMergeCommand(raw: string): { matched: boolean; title?: string } {
  const text = raw.trim();
  if (!text) return { matched: false };
  const slash = /^\/(?:merge|병합)(?:\s+(.+))?$/i.exec(text);
  if (slash) return { matched: true, title: slash[1]?.trim() };
  if (/^(?:병합(?:해줘|해)?|합쳐(?:줘)?|합치기|merge|combine)$/i.test(text)) {
    return { matched: true };
  }
  const suffix = /^(.+?)\s*(?:로|을|를)?\s*(?:병합(?:해줘|해)?|합쳐(?:줘)?|합치기)$/.exec(text);
  if (suffix) return { matched: true, title: suffix[1]?.trim() };
  return { matched: false };
}
