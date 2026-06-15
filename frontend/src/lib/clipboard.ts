/** 클립보드 복사 헬퍼.
 *
 * navigator.clipboard 는 보안 컨텍스트(HTTPS / localhost) 에서만
 * 노출되므로, 폐쇄망 HTTP 배포에선 *없는 객체*다. 그대로 호출하면
 * "Cannot read properties of undefined (reading 'writeText')" 가 나서
 * 사용자에겐 그냥 '실패' 로만 보임. 이 모듈이 우선순위대로 시도:
 *
 *   1) navigator.clipboard.writeText (있을 때)
 *   2) 임시 <textarea> + document.execCommand("copy") (legacy)
 *   3) window.prompt(message, text) — 사용자가 손으로 Ctrl+C
 *
 * 셋 다 실패하면 false 반환.  성공이면 true.
 */
export async function copyText(
  text: string,
  promptMessage = "아래 텍스트를 복사하세요",
): Promise<boolean> {
  // 1) 표준 Clipboard API.
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard?.writeText
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 권한 거부 / focus 부재 — 다음 전략으로.
  }
  // 2) legacy execCommand.  iOS 사파리에서도 동작.  단, 일부 모바일
  // 브라우저에서 execCommand 결과가 false 면 prompt 폴백.
  try {
    if (typeof document !== "undefined") {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.left = "0";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
      if (ok) return true;
    }
  } catch {
    /* fall through */
  }
  // 3) 최후 — 사용자에게 직접 복사 부탁.
  try {
    if (typeof window !== "undefined") {
      window.prompt(promptMessage, text);
      return true;
    }
  } catch {
    /* nothing more we can do */
  }
  return false;
}
