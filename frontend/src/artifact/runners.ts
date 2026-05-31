import PyodideWorker from "./pyodideWorker?worker";

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

// ── Pyodide Web Worker (singleton) ────────────────────────────────────
let _worker: Worker | null = null;
let _runCounter = 0;

function getWorker(): Worker {
  if (_worker) return _worker;
  _worker = new PyodideWorker();
  return _worker;
}

interface WorkerMsg {
  type: "progress" | "stdout" | "stderr" | "done" | "error";
  message?: string;
  chunk?: string;
  id?: string;
}

export function runPython(
  code: string,
  onProgress?: (msg: string) => void
): Promise<RunResult> {
  const start = performance.now();
  const id = `run-${++_runCounter}`;
  const buf: string[] = [];
  return new Promise((resolve) => {
    const worker = getWorker();
    const handle = (ev: MessageEvent<WorkerMsg>) => {
      const m = ev.data;
      if (m.type === "progress") {
        onProgress?.(m.message ?? "");
        return;
      }
      if (m.id !== id) return;
      if (m.type === "stdout" || m.type === "stderr") {
        buf.push(m.chunk ?? "");
      } else if (m.type === "done") {
        worker.removeEventListener("message", handle);
        resolve({
          ok: true,
          durationMs: Math.round(performance.now() - start),
          output: buf.join("") || "(출력 없음)",
        });
      } else if (m.type === "error") {
        worker.removeEventListener("message", handle);
        resolve({
          ok: false,
          durationMs: Math.round(performance.now() - start),
          output:
            buf.join("") + (buf.length ? "\n" : "") + (m.message ?? "unknown error"),
        });
      }
    };
    worker.addEventListener("message", handle);
    worker.postMessage({ type: "run", code, id });
  });
}

// ── JS sandbox (iframe + postMessage) ─────────────────────────────────
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
      if (ev.source !== iframe.contentWindow) return;
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

    const safeCode = code.replace(/<\/script/gi, "<\\/script");
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
      ${safeCode}
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
