import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthContext";
import { BrandLogo } from "../components/BrandLogo";
import { PasswordStrength } from "./PasswordStrength";

interface Props {
  /** "login" or "signup" - controls form fields shown. */
  initialMode?: "login" | "signup";
  onForgot?: () => void;
}

export function AuthForm({ initialMode = "login", onForgot }: Props) {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    // The button goes disabled while busy, but Enter inside an input
    // can still fire onSubmit in some browsers — guard against the
    // race so a double-tap doesn't send two login requests.
    if (busy) return;
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
        <h1 className="auth-brand">
          <BrandLogo size={32} aria-label="Chat 로고" />
          <span>Chat</span>
        </h1>
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
            // Only enforce minLength on signup. For login we MUST NOT
            // pre-validate length client-side: any legacy account
            // whose password happens to be <8 chars would otherwise
            // be silently blocked by the browser's built-in form
            // validation (small tooltip, no error in our own error
            // surface) — the user just sees "Enter doesn't work".
            minLength={mode === "signup" ? 8 : undefined}
            required
          />
          {mode === "signup" && (
            <small className="auth-hint">
              8자 이상 · 영문 대/소문자 · 숫자 · 기호 중 2종류 이상
            </small>
          )}
          {mode === "signup" && (
            <PasswordStrength password={password} email={email} name={name} />
          )}
        </label>

        {error && <div className="auth-error">{error}</div>}

        <button
          type="submit"
          className={`auth-submit${busy ? " busy" : ""}`}
          disabled={busy}
        >
          {busy && <span className="auth-submit-spinner" aria-hidden />}
          <span>
            {busy
              ? mode === "login"
                ? "로그인 중..."
                : "가입 중..."
              : mode === "login"
              ? "로그인"
              : "회원가입"}
          </span>
        </button>

        {mode === "login" && onForgot && (
          <div className="auth-switch">
            <button type="button" onClick={onForgot}>
              비밀번호를 잊으셨나요?
            </button>
          </div>
        )}

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
