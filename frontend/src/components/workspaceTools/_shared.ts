/** WorkspaceTools 패널들이 공유하는 작은 헬퍼들. */

/** 파일·git 상태가 바뀌면 트리·status 패널이 다시 가져오도록 한 번
 *  쏴 주는 헬퍼.  ws:tree-refresh 를 WorkspaceTree 가 listen. */
export function notifyTreeChanged() {
  window.dispatchEvent(new CustomEvent("ws:tree-refresh"));
}

export const RECENT_KEY = (wid: string) => `ws:${wid}:recent`;
export const PIN_KEY = (wid: string) => `ws:${wid}:pinned`;

export function readArr(k: string): string[] {
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return [];
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function writeArr(k: string, arr: string[]) {
  try {
    localStorage.setItem(k, JSON.stringify(arr.slice(0, 200)));
  } catch {
    /* quota etc */
  }
}

/** 최근 본 파일 기록 — Recent panel 에서 사용. */
export function recordRecentFile(workspaceId: string, path: string) {
  const key = RECENT_KEY(workspaceId);
  const cur = readArr(key).filter((p) => p !== path);
  cur.unshift(path);
  writeArr(key, cur.slice(0, 30));
}
