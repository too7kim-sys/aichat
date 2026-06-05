import { useState, type FormEvent } from "react";
import { auth, setToken } from "../api/client";
import { PasswordStrength } from "./PasswordStrength";
import { IconChat } from "../components/Icon";

interface Props {
  token: string;
  onDone: () => void;
}

export function ResetPasswordForm({ token, onDone }: Props) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("두 비밀번호가 일치하지 않습니다");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await auth.confirmPasswordReset(token, password);
      setToken(res.access_token);
      // Force a page reload so AuthGate re-evaluates with the new token
      // and the URL params are stripped from the bar.
      window.location.replace("/");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+\s/, "") : "오류");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="auth-brand">
          <IconChat size={32} aria-label="Chat 로고" />
          <span>Chat</span>
        </h1>
        <h2 className="auth-title">새 비밀번호 설정</h2>

        <label className="auth-field">
          <span>새 비밀번호</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
          <small className="auth-hint">
            8자 이상 · 영문 대/소문자 · 숫자 · 기호 중 2종류 이상
          </small>
          <PasswordStrength password={password} />
        </label>

        <label className="auth-field">
          <span>비밀번호 확인</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>

        {error && <div className="auth-error">{error}</div>}

        <button type="submit" className="auth-submit" disabled={busy}>
          {busy ? "변경 중..." : "비밀번호 변경"}
        </button>
      </form>
    </div>
  );
}
