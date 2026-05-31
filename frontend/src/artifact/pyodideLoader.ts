/**
 * Lazy loader for Pyodide from the official CDN.
 *
 * Pyodide ships as ~10 MB of wasm + Python stdlib, so we don't bundle it.
 * The first call to loadPyodideOnce injects the CDN <script> tag and
 * resolves the singleton instance; subsequent calls return the cached one.
 */

const PYODIDE_VERSION = "0.26.4";
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

declare global {
  interface Window {
    loadPyodide?: (config: { indexURL: string; stdout?: (s: string) => void; stderr?: (s: string) => void }) => Promise<PyodideInstance>;
  }
}

export interface PyodideInstance {
  runPythonAsync: (code: string) => Promise<unknown>;
  setStdout: (cfg: { batched: (s: string) => void }) => void;
  setStderr: (cfg: { batched: (s: string) => void }) => void;
  globals: { set: (k: string, v: unknown) => void };
}

let _pyodide: PyodideInstance | null = null;
let _loadingPromise: Promise<PyodideInstance> | null = null;

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-pyodide="1"]`)) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.dataset.pyodide = "1";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

export async function loadPyodideOnce(
  onProgress?: (msg: string) => void
): Promise<PyodideInstance> {
  if (_pyodide) return _pyodide;
  if (_loadingPromise) return _loadingPromise;

  _loadingPromise = (async () => {
    onProgress?.("Pyodide 스크립트 다운로드 중...");
    try {
      await injectScript(`${PYODIDE_CDN}pyodide.js`);
      if (!window.loadPyodide) {
        throw new Error("window.loadPyodide is unavailable after script load");
      }
      onProgress?.("Python 런타임 초기화 중 (~10MB, 처음 한 번만)...");
      const py = await window.loadPyodide({ indexURL: PYODIDE_CDN });
      _pyodide = py;
      onProgress?.("준비 완료");
      return py;
    } catch (err) {
      // Remove the (possibly broken) script tag so a retry can re-inject.
      document.querySelector('script[data-pyodide="1"]')?.remove();
      throw err;
    }
  })();

  try {
    return await _loadingPromise;
  } finally {
    _loadingPromise = null;
  }
}
