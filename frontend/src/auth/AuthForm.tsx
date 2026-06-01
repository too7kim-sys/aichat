import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthContext";

interface Props {
  /** "login" or "signup" - controls form fields shown. */
  initialMode?: "login" | "signup";
}

export function AuthForm({ initialMode = "login" }: Props) {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        await login(email.trim(), password);
      } else {
        await signup(email.trim(), password, name.trim());
      }
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
        <h2 className="auth-title">
          {mode === "login" ? "로그인" : "회원가입"}
        </h2>

        {mode === "signup" && (
          <label className="auth-field">
            <span>이름</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              maxLength={80}
            />
          </label>
        )}

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

        <label className="auth-field">
          <span>비밀번호</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={8}
            required
          />
          {mode === "signup" && (
            <small className="auth-hint">8자 이상</small>
          )}
        </label>

        {error && <div className="auth-error">{error}</div>}

        <button type="submit" className="auth-submit" disabled={busy}>
          {busy
            ? mode === "login"
              ? "로그인 중..."
              : "가입 중..."
            : mode === "login"
            ? "로그인"
            : "회원가입"}
        </button>

        <div className="auth-switch">
          {mode === "login" ? (
            <>
              계정이 없으신가요?{" "}
              <button
                type="button"
                onClick={() => {
                  setMode("signup");
                  setError(null);
                }}
              >
                회원가입
              </button>
            </>
          ) : (
            <>
              이미 계정이 있으신가요?{" "}
              <button
                type="button"
                onClick={() => {
                  setMode("login");
                  setError(null);
                }}
              >
                로그인
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
