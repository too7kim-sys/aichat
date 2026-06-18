/** 공용 에러/안내 토스트 헬퍼.
 *
 * 1) `window.alert()` 의 모달 펑션을 줄이는 게 목적 — 사용자가 작업
 *    흐름 중에 모달로 깨지지 않도록 우측 하단 토스트로 일관.
 * 2) 에러 메시지를 한국어로 친화 매핑.  HTTP 코드 / fetch 예외 / raw
 *    Error 메시지를 user-friendly 한 줄로.
 *
 * 사용 예:
 *   import { errorToast, infoToast } from "../lib/toast";
 *   try { await api.foo() } catch (e) { errorToast("저장에 실패", e) }
 *   infoToast("📋 복사됐어요");
 */

function dispatch(text: string): void {
  window.dispatchEvent(
    new CustomEvent("chat:toast", { detail: { text } }),
  );
}

/** 사람이 읽기 좋은 한국어 한 줄로 변환.  HTTP 코드가 message 앞에
 *  붙는 우리 fetch 헬퍼(HttpError) 패턴을 우선 처리한다. */
function friendlyMessage(err: unknown): string {
  if (err == null) return "알 수 없는 오류";
  if (err instanceof Error) {
    const msg = err.message || "";
    // "404 message not found" 같은 패턴 → 한국어로.
    const m = msg.match(/^(\d{3})\s+(.*)$/);
    if (m) {
      const code = Number(m[1]);
      const detail = m[2].trim();
      if (code === 401) return "로그인이 만료됐어요.  다시 로그인해 주세요.";
      if (code === 403) return detail || "권한이 없어요.";
      if (code === 404) return detail || "요청한 항목을 찾을 수 없어요.";
      if (code === 409) return detail || "이미 처리된 작업이에요.";
      if (code === 413) return "파일이 너무 큽니다.";
      if (code === 422) return detail || "입력값이 올바르지 않아요.";
      if (code === 423) return detail || "잠시 후 다시 시도해 주세요.";
      if (code === 429) return "요청이 너무 잦아요.  잠시 후 다시.";
      if (code >= 500) return "서버 오류가 발생했어요.  잠시 후 다시 시도해 주세요.";
      return detail || msg;
    }
    if (msg === "Failed to fetch" || msg.includes("NetworkError")) {
      return "네트워크 오류 — 서버에 연결할 수 없어요.";
    }
    return msg;
  }
  return String(err);
}

/** 에러 토스트 — prefix + 친화 메시지.  prefix 는 사용자가 무엇이
 *  실패했는지 알 수 있게 ("저장에 실패", "삭제 실패" 등).  err 가
 *  비어 있어도 prefix 만 노출. */
export function errorToast(prefix: string, err?: unknown): void {
  const detail = err === undefined ? "" : friendlyMessage(err);
  dispatch(detail ? `${prefix}: ${detail}` : prefix);
}

/** 안내 토스트 — '복사됐어요' 같은 가벼운 성공 메시지. */
export function infoToast(text: string): void {
  if (!text) return;
  dispatch(text);
}
