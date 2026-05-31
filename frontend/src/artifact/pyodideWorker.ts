/// <reference lib="webworker" />
/**
 * Web Worker that hosts a Pyodide instance so Python execution doesn't
 * block the main thread.
 *
 * Protocol (parent → worker):
 *   { type: "init" }
 *   { type: "run",  code: string, id: string }
 *
 * Protocol (worker → parent):
 *   { type: "progress", message: string }
 *   { type: "stdout",   chunk: string,  id: string }
 *   { type: "stderr",   chunk: string,  id: string }
 *   { type: "done",     id: string }
 *   { type: "error",    message: string, id: string }
 */

const PYODIDE_VERSION = "0.26.4";
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

interface PyInstance {
  runPythonAsync: (code: string) => Promise<unknown>;
  setStdout: (cfg: { batched: (s: string) => void }) => void;
  setStderr: (cfg: { batched: (s: string) => void }) => void;
}

interface WorkerGlobals {
  loadPyodide?: (cfg: {
    indexURL: string;
  }) => Promise<PyInstance>;
  importScripts: (...urls: string[]) => void;
  postMessage: (msg: unknown) => void;
  addEventListener: (
    event: "message",
    handler: (ev: MessageEvent) => void
  ) => void;
}

const ctx = self as unknown as WorkerGlobals;

let py: PyInstance | null = null;
let loading: Promise<PyInstance> | null = null;

function report(type: string, payload: Record<string, unknown> = {}) {
  ctx.postMessage({ type, ...payload });
}

async function ensurePyodide(): Promise<PyInstance> {
  if (py) return py;
  if (loading) return loading;
  loading = (async () => {
    try {
      report("progress", { message: "Pyodide 다운로드 중..." });
      ctx.importScripts(`${PYODIDE_CDN}pyodide.js`);
      if (!ctx.loadPyodide) {
        throw new Error("loadPyodide unavailable after importScripts");
      }
      report("progress", { message: "Python 런타임 초기화 중 (~10MB, 처음 한 번만)..." });
      const inst = await ctx.loadPyodide({ indexURL: PYODIDE_CDN });
      py = inst;
      report("progress", { message: "준비 완료" });
      return inst;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

ctx.addEventListener("message", async (ev: MessageEvent) => {
  const msg = ev.data as { type: string; code?: string; id?: string };
  if (msg.type === "init") {
    try {
      await ensurePyodide();
      report("done", { id: "__init__" });
    } catch (e) {
      report("error", { message: String(e), id: "__init__" });
    }
    return;
  }
  if (msg.type === "run") {
    const id = msg.id ?? "";
    try {
      const inst = await ensurePyodide();
      inst.setStdout({ batched: (s) => report("stdout", { chunk: s, id }) });
      inst.setStderr({ batched: (s) => report("stderr", { chunk: s, id }) });
      await inst.runPythonAsync(msg.code ?? "");
      report("done", { id });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      report("error", { message, id });
    }
  }
});
