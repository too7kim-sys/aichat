import { useState } from "react";
import { auth } from "../api/client";
import { useAuth } from "./AuthContext";

export function VerifyBanner() {
  const { user } = useAuth();
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!user || user.email_verified) return null;

  async function resend() {
    setSending(true);
    setMessage(null);
    try {
      await auth.resendVerify();
      setMessage("인증 메일을 다시 보냈습니다. 메일함을 확인해 주세요.");
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message.replace(/^\d+\s/, "") : "전송 실패"
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="verify-banner">
      <span>
        이메일 인증이 필요합니다. <strong>{user.email}</strong>로 발송된 메일의
        링크를 클릭해 주세요.
      </span>
      <button onClick={resend} disabled={sending}>
        {sending ? "보내는 중..." : "인증 메일 재발송"}
      </button>
      {message && <div className="verify-banner-msg">{message}</div>}
    </div>
  );
}
