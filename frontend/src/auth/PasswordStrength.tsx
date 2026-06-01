interface Props {
  password: string;
  /** Used to refuse passwords that contain identifying info. */
  email?: string;
  name?: string;
}

const COMMON = new Set([
  "password", "password1", "12345678", "123456789", "qwerty", "qwerty123",
  "letmein", "welcome", "admin", "iloveyou", "abc12345", "1q2w3e4r",
  "p@ssw0rd", "passw0rd", "monkey1",
]);

interface Score {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  reasons: string[];
}

export function scorePassword(
  pw: string,
  opts: { email?: string; name?: string } = {}
): Score {
  if (!pw) return { score: 0, label: "비어 있음", reasons: [] };

  const reasons: string[] = [];
  const lowered = pw.toLowerCase();
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9\s]/].filter((r) =>
    r.test(pw)
  ).length;

  if (pw.length < 8) reasons.push("8자 이상 필요");
  if (classes < 2) reasons.push("대/소문자·숫자·기호 중 2종류 이상");
  if (COMMON.has(lowered)) reasons.push("흔한 비밀번호");
  if (opts.email) {
    const local = opts.email.split("@", 1)[0].toLowerCase();
    if (local.length >= 4 && lowered.includes(local))
      reasons.push("이메일 포함");
  }
  if (opts.name && opts.name.length >= 3 && lowered.includes(opts.name.toLowerCase()))
    reasons.push("이름 포함");

  // Base 0–4 score from length + variety, then knock down by reasons.
  let base = 0;
  if (pw.length >= 8) base += 1;
  if (pw.length >= 12) base += 1;
  if (classes >= 3) base += 1;
  if (classes >= 4 && pw.length >= 10) base += 1;
  if (reasons.length > 0) base = Math.min(base, 1);

  const label =
    reasons.length > 0 && pw.length < 8
      ? "약함"
      : ["매우 약함", "약함", "보통", "강함", "매우 강함"][base];
  return { score: base as Score["score"], label, reasons };
}

export function PasswordStrength({ password, email, name }: Props) {
  const { score, label, reasons } = scorePassword(password, { email, name });
  if (!password) return null;
  return (
    <div className="pw-strength">
      <div className={`pw-strength-bar level-${score}`}>
        <span style={{ width: `${(score / 4) * 100}%` }} />
      </div>
      <div className="pw-strength-row">
        <span className={`pw-strength-label level-${score}`}>{label}</span>
        {reasons.length > 0 && (
          <span className="pw-strength-reasons">
            {reasons.join(" · ")}
          </span>
        )}
      </div>
    </div>
  );
}
