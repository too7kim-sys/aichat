/**
 * Detect "file: <path>" hints in fenced code blocks emitted by the LLM
 * and extract a (path, language, code) list suitable for batch saving.
 *
 * Recognised forms (case-insensitive on the keyword):
 *   ```python file: src/foo.py
 *   ...
 *   ```
 *
 *   ```python src/foo.py
 *   ...
 *   ```
 *
 *   ```python
 *   # file: src/foo.py
 *   ...
 *   ```
 *
 *   ```python
 *   // file: src/foo.tsx
 *   ...
 *   ```
 */

export interface ProposedFile {
  path: string;
  language: string;
  content: string;
}

const FENCE_RE = /^(?<indent> *)```([^\n]*)\n([\s\S]*?)\n\1?```$/gm;
const PATH_HINT_RE = /(?:file\s*:\s*)?([./\w-]+\.[\w.]+)/i;
const FIRST_LINE_HINT_RE =
  /^\s*(?:#|\/\/|--)\s*file\s*:\s*([./\w-]+\.[\w.]+)\s*$/im;

function looksLikePath(s: string): boolean {
  return /\.[A-Za-z0-9_]+$/.test(s) && !s.includes(" ");
}

export function extractProposedFiles(markdown: string): ProposedFile[] {
  const out: ProposedFile[] = [];
  for (const m of markdown.matchAll(FENCE_RE)) {
    const info = (m[2] ?? "").trim();
    const body = m[3] ?? "";
    let path: string | null = null;
    let language = "";

    if (info) {
      const tokens = info.split(/\s+/);
      language = tokens[0] || "";
      // Look for a token like "file:src/foo.py" or "src/foo.py"
      for (const tok of tokens.slice(1)) {
        const mm = PATH_HINT_RE.exec(tok);
        if (mm && looksLikePath(mm[1])) {
          path = mm[1];
          break;
        }
      }
    }

    // Fall back to a # file: / // file: comment on the first line of the body.
    if (!path) {
      const lineMatch = FIRST_LINE_HINT_RE.exec(body);
      if (lineMatch && looksLikePath(lineMatch[1])) {
        path = lineMatch[1];
      }
    }

    if (path) {
      // Strip the hint comment from the saved body so it doesn't end up in
      // the written file.
      const cleanedBody = body.replace(FIRST_LINE_HINT_RE, "").replace(/^\n/, "");
      out.push({ path, language, content: cleanedBody });
    }
  }
  return out;
}
