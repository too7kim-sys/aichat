import { loadPyodideOnce } from "./pyodideLoader";

export interface RunResult {
  ok: boolean;
  durationMs: number;
  output: string;
}

export type Runnable = "python" | "javascript" | "html";

export function detectRunnable(lang: string): Runnable | null {
  const l = lang.toLowerCase();
  if (l === "python" || l === "py") return "python";
  if (l === "javascript" || l === "js") return "javascript";
  if (l === "html" || l === "htm") return "html";
  return null;
}

export async function runPython(
  code: string,
  onProgress?: (msg: string) => void
): Promise<RunResult> {
  const start = performance.now();
  const lines: string[] = [];
  try {
    const py = await loadPyodideOnce(onProgress);
    py.setStdout({ batched: (s) => lines.push(s) });
    py.setStderr({ batched: (s) => lines.push(s) });
    onProgress?.("실행 중...");
    await py.runPythonAsync(code);
    return {
      ok: true,
      durationMs: Math.round(performance.now() - start),
      output: lines.join("") || "(출력 없음)",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      durationMs: Math.round(performance.now() - start),
      output: lines.join("") + (lines.length ? "\n" : "") + msg,
    };
  }
}

/**
 * Run JavaScript in a same-origin sandboxed iframe and collect console output
 * via postMessage. Times out after 5 s.
 */
export function runJavaScript(code: string, timeoutMs = 5000): Promise<RunResult> {
  return new Promise((resolve) => {
    const start = performance.now();
    const iframe = document.createElement("iframe");
    iframe.sandbox.add("allow-scripts");
    iframe.style.display = "none";
    const channel = `__chat_run_${Math.random().toString(36).slice(2)}`;
    const outputs: string[] = [];

    const finish = (ok: boolean) => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      iframe.remove();
      resolve({
        ok,
        durationMs: Math.round(performance.now() - start),
        output: outputs.join("") || "(출력 없음)",
      });
    };

    function onMessage(ev: MessageEvent) {
      const data = ev.data;
      if (!data || data.channel !== channel) return;
      if (data.type === "log") outputs.push(data.value + "\n");
      else if (data.type === "error") {
        outputs.push(`Error: ${data.value}\n`);
        finish(false);
      } else if (data.type === "done") finish(true);
    }
    window.addEventListener("message", onMessage);

    const timer = window.setTimeout(() => {
      outputs.push(`\n[timeout after ${timeoutMs}ms]`);
      finish(false);
    }, timeoutMs);

    const srcDoc = `<!doctype html><html><body><script>
(function(){
  const ch = ${JSON.stringify(channel)};
  const send = (type, value) => parent.postMessage({channel: ch, type, value}, '*');
  const stringify = (a) => a.map(x => {
    if (typeof x === 'string') return x;
    try { return JSON.stringify(x, null, 2); } catch { return String(x); }
  }).join(' ');
  ['log','info','warn','error'].forEach(level => {
    const orig = console[level];
    console[level] = (...a) => { try { orig.apply(console, a); } catch {} send('log', stringify(a)); };
  });
  window.addEventListener('error', e => send('error', e.message));
  window.addEventListener('unhandledrejection', e => send('error', String(e.reason)));
  (async () => {
    try {
      ${code}
      send('done');
    } catch (e) { send('error', e.message || String(e)); }
  })();
})();
<\/script></body></html>`;
    iframe.srcdoc = srcDoc;
    document.body.appendChild(iframe);
  });
}

export async function run(
  code: string,
  lang: string,
  onProgress?: (msg: string) => void
): Promise<RunResult> {
  const kind = detectRunnable(lang);
  if (kind === "python") return runPython(code, onProgress);
  if (kind === "javascript") return runJavaScript(code);
  return {
    ok: false,
    durationMs: 0,
    output: `'${lang}'는 브라우저 실행이 지원되지 않습니다. 지원: Python, JavaScript, HTML(preview).`,
  };
}
