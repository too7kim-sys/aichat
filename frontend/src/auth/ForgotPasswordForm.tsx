import { useState, type FormEvent } from "react";
import { auth } from "../api/client";

interface Props {
  onBack: () => void;
}

export function ForgotPasswordForm({ onBack }: Props) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+\s/, "") : "오류");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="auth-brand">Chat</h1>
        <h2 className="auth-title">비밀번호 재설정</h2>

        {sent ? (
          <>
            <p className="auth-note">
              입력한 이메일이 등록되어 있으면 재설정 링크가 전송됩니다.
              메일함을 확인해 주세요. 링크는 1시간 동안 유효합니다.
            </p>
            <button
              type="button"
              className="auth-submit"
              onClick={onBack}
            >
              로그인으로 돌아가기
            </button>
          </>
        ) : (
          <>
            <label className="auth-field">
              <span>이메일</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </label>
            {error && <div className="auth-error">{error}</div>}
            <button type="submit" className="auth-submit" disabled={busy}>
              {busy ? "전송 중..." : "재설정 링크 받기"}
            </button>
            <div className="auth-switch">
              <button type="button" onClick={onBack}>
                ← 로그인으로
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
