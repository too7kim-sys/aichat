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
 *   { type: "image",    pngBase64: string, id: string }
 *   { type: "done",     id: string }
 *   { type: "error",    message: string, id: string }
 */

const PYODIDE_VERSION = "0.26.4";
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

interface PyInstance {
  runPythonAsync: (code: string) => Promise<unknown>;
  loadPackagesFromImports: (code: string) => Promise<unknown>;
  loadPackage: (
    pkgs: string | string[],
    opts?: { messageCallback?: (s: string) => void }
  ) => Promise<unknown>;
  setStdout: (cfg: { batched: (s: string) => void }) => void;
  setStderr: (cfg: { batched: (s: string) => void }) => void;
  globals: {
    get: (k: string) => unknown;
    set: (k: string, v: unknown) => void;
  };
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

// Wraps user code so matplotlib figures (if any) are captured as base64
// PNGs after the script finishes, then emitted as 'image' events.
const FIGURE_CAPTURE_WRAPPER = `
import sys as _sys
_user_globals = {}
try:
    exec(compile(_USER_CODE_, "<artifact>", "exec"), _user_globals)
finally:
    pass

_captured_figs = []
try:
    import matplotlib
    matplotlib.use("AGG")  # safe for worker; we serialize ourselves
    import matplotlib.pyplot as _plt
    import io as _io, base64 as _b64
    for _n in _plt.get_fignums():
        _fig = _plt.figure(_n)
        _buf = _io.BytesIO()
        _fig.savefig(_buf, format="png", dpi=110, bbox_inches="tight")
        _buf.seek(0)
        _captured_figs.append(_b64.b64encode(_buf.read()).decode())
        _plt.close(_fig)
except Exception:
    pass
_captured_figs
`;

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
    const code = msg.code ?? "";
    try {
      const inst = await ensurePyodide();
      inst.setStdout({ batched: (s) => report("stdout", { chunk: s, id }) });
      inst.setStderr({ batched: (s) => report("stderr", { chunk: s, id }) });

      // Auto-install referenced packages (numpy, pandas, matplotlib, ...).
      try {
        report("progress", { message: "필요 패키지 확인 중..." });
        await inst.loadPackagesFromImports(code);
      } catch (e) {
        // Non-fatal; user code will raise ImportError if a needed pkg is
        // not in pyodide's bundle.
        report("stderr", { chunk: `[package load: ${String(e)}]\n`, id });
      }
      report("progress", { message: "실행 중..." });

      // Bind the user's source under a Python global, then run the wrapper
      // that exec()s it and harvests matplotlib figures.
      inst.globals.set("_USER_CODE_", code);
      const result = (await inst.runPythonAsync(FIGURE_CAPTURE_WRAPPER)) as
        | { toJs?: (opts?: unknown) => string[]; destroy?: () => void }
        | string[]
        | null;

      let figs: string[] = [];
      if (Array.isArray(result)) figs = result;
      else if (result && typeof (result as { toJs?: unknown }).toJs === "function") {
        figs = (result as { toJs: (o?: unknown) => string[] }).toJs();
        (result as { destroy?: () => void }).destroy?.();
      }
      for (const png of figs) {
        report("image", { pngBase64: png, id });
      }
      report("done", { id });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      report("error", { message, id });
    }
  }
});
