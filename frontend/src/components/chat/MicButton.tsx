/** 🎙 음성 입력 버튼 — Whisper STT 로 마이크 캡처 → 텍스트 변환. */
import { useRef, useState } from "react";
import { api } from "../../api/client";
import { errorToast, infoToast } from "../../lib/toast";

export function MicButton({
  disabled,
  onTranscribed,
}: {
  disabled: boolean;
  onTranscribed: (text: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // 환경 점검 — getUserMedia 가 동작하는 조건:
  //   1) 보안 컨텍스트 (https:// 또는 localhost / 127.0.0.1)
  //   2) navigator.mediaDevices 존재
  // 둘 다 만족해도 클릭 시 사용자가 마이크 거부하면 NotAllowedError.
  // 폐쇄망이라도 IP/HTTP 로 접속하면 브라우저가 mediaDevices 자체를
  // 노출하지 않으므로, 버튼은 그대로 보이되 누르면 "왜 안 되는지"
  // 정확히 알려주는 안내가 더 친절.
  const isSecure =
    typeof window !== "undefined" &&
    (window.isSecureContext ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1");
  const hasGUM =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const supported = isSecure && hasGUM;

  async function start() {
    if (!supported) {
      const why = !isSecure
        ? "이 페이지가 HTTPS 가 아니라 브라우저가 마이크 권한 요청 자체를 막아요. " +
          "관리자에게 HTTPS 적용 또는 localhost 로 접속을 요청해 주세요."
        : "이 브라우저는 마이크 캡처 API 를 지원하지 않아요. 최신 Chrome / Edge / Firefox 로 다시 시도해 주세요.";
      infoToast(`🎙 음성 입력 사용 불가 — ${why}`);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mime || "audio/webm" });
        chunksRef.current = [];
        if (blob.size === 0) return;
        setBusy(true);
        try {
          const r = await api.transcribeInline(blob);
          if (r.text) onTranscribed(r.text);
        } catch (e) {
          errorToast("음성 인식 실패", e);
        } finally {
          setBusy(false);
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      // NotAllowedError 면 사용자가 권한을 거부했거나, 시스템 설정에서
      // 사이트별 마이크 권한이 차단된 상태.  공식 안내 문구를 곁들임.
      const name = (e as { name?: string }).name || "";
      const msg = e instanceof Error ? e.message : String(e);
      let hint = "";
      if (name === "NotAllowedError" || /permission/i.test(msg)) {
        hint =
          "\n\n주소창 좌측 자물쇠 아이콘 → '사이트 권한 → 마이크' 를 " +
          "'허용' 으로 바꾼 뒤 다시 시도해 주세요.";
      } else if (name === "NotFoundError" || /not found/i.test(msg)) {
        hint = "\n\n시스템에 마이크 장치가 인식되지 않았어요. 케이블/드라이버를 확인해 주세요.";
      } else if (name === "NotReadableError") {
        hint = "\n\n다른 앱(Zoom·Teams 등) 이 마이크를 잡고 있을 수 있어요. 그 앱 종료 후 재시도.";
      }
      infoToast(`🎙 마이크 접근 실패 (${name || "오류"}) — ${msg}${hint}`);
    }
  }
  function stop() {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    setRecording(false);
  }

  return (
    <button
      type="button"
      className={`composer-mic-btn${recording ? " recording" : ""}${
        supported ? "" : " unsupported"
      }`}
      onClick={recording ? stop : start}
      disabled={disabled || busy}
      title={
        !supported
          ? "🎙 음성 입력 사용 불가 — HTTPS 환경에서만 동작 (클릭하면 자세한 안내)"
          : busy
            ? "전사 중…"
            : recording
              ? "녹음 중 — 클릭해 멈추고 전사"
              : "🎙 음성 입력"
      }
    >
      {busy ? "⏳" : recording ? "⏹" : "🎙"}
    </button>
  );
}
