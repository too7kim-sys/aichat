import { useEffect, useState, type FormEvent } from "react";
import { api, auth, type AuditEvent } from "../api/client";
import { copyText } from "../lib/clipboard";
import { errorToast, infoToast } from "../lib/toast";
import { useAuth } from "./AuthContext";
import { PasswordStrength } from "./PasswordStrength";

interface Props {
  onBack: () => void;
}

export function MyPage({ onBack }: Props) {
  const { user, logout, setUser } = useAuth();
  const [name, setName] = useState(user?.name ?? "");
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  type Sess = Awaited<ReturnType<typeof auth.listMySessions>>["items"][number];
  const [sessions, setSessions] = useState<Sess[]>([]);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    auth.myAudit(20).then(setEvents).catch(() => {});
    auth
      .listMySessions()
      .then((r) => setSessions(r.items))
      .catch(() => setSessions([]));
  }, []);

  async function revokeOtherDevices() {
    if (!window.confirm(
      "다른 디바이스에서 로그인된 세션을 모두 끊을까요?  현재 사용 중인 토큰도 함께 끊겨 다시 로그인해야 합니다.",
    )) return;
    setRevoking(true);
    try {
      await auth.logoutAllOtherDevices();
      infoToast("다른 디바이스 세션을 모두 끊었어요. 다시 로그인해 주세요.");
      // 본인 토큰도 invalidate 되므로 곧장 로그아웃 화면으로.
      logout();
    } catch (e) {
      errorToast("작업 실패", e);
    } finally {
      setRevoking(false);
    }
  }

  if (!user) return null;

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const updated = await auth.updateMe({ name });
      setUser(updated);
      setMessage("이름 저장됨");
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+\s/, "") : "오류");
    } finally {
      setSaving(false);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (newPw.length < 10) {
      setError("새 비밀번호는 10자 이상이어야 합니다");
      return;
    }
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      await auth.updateMe({ current_password: currentPw, new_password: newPw });
      setCurrentPw("");
      setNewPw("");
      setMessage("비밀번호 변경됨");
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+\s/, "") : "오류");
    } finally {
      setSaving(false);
    }
  }

  async function deleteAccount() {
    const ok = window.confirm(
      "정말 계정을 삭제할까요? 모든 대화·세션도 함께 영구 삭제됩니다."
    );
    if (!ok) return;
    try {
      await auth.deleteMe();
      logout();
    } catch (e) {
      alert(e instanceof Error ? e.message : "삭제 실패");
    }
  }

  return (
    <div className="mypage-shell">
      <div className="mypage-card">
        <div className="mypage-header">
          <h1>마이페이지</h1>
          <button className="mypage-back" onClick={onBack}>
            ← 대화로
          </button>
        </div>

        <div className="mypage-section">
          <h2>계정</h2>
          <div className="mypage-row">
            <span className="mypage-label">이메일</span>
            <span className="mypage-value">{user.email}</span>
          </div>
          <div className="mypage-row">
            <span className="mypage-label">가입일</span>
            <span className="mypage-value">
              {new Date(user.created_at).toLocaleString("ko-KR")}
            </span>
          </div>
        </div>

        <form className="mypage-section" onSubmit={saveName}>
          <h2>이름</h2>
          <div className="mypage-form-row">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="표시할 이름"
            />
            <button className="primary" type="submit" disabled={saving}>
              저장
            </button>
          </div>
        </form>

        <form className="mypage-section" onSubmit={changePassword}>
          <h2>비밀번호 변경</h2>
          <input
            type="password"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            placeholder="현재 비밀번호"
            autoComplete="current-password"
            required
          />
          <input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="새 비밀번호 (8자 이상, 2종류 이상)"
            autoComplete="new-password"
            minLength={8}
            required
          />
          <PasswordStrength
            password={newPw}
            email={user.email}
            name={user.name}
          />
          <button className="primary" type="submit" disabled={saving}>
            비밀번호 변경
          </button>
        </form>

        <div className="mypage-section">
          <h2>🔑 API 키</h2>
          <ApiKeysPanel />
        </div>

        <div className="mypage-section">
          <h2>최근 활동</h2>
          {events.length === 0 ? (
            <p className="mypage-hint">기록 없음</p>
          ) : (
            <ul className="audit-list">
              {events.map((e) => (
                <li key={e.id}>
                  <span className={`audit-badge audit-${e.event}`}>
                    {labelFor(e.event)}
                  </span>
                  <span className="audit-time">
                    {new Date(e.created_at).toLocaleString("ko-KR")}
                  </span>
                  <span className="audit-meta">
                    {e.ip}
                    {e.detail && ` · ${e.detail}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {(message || error) && (
          <div className={`mypage-flash ${error ? "error" : "ok"}`}>
            {error || message}
          </div>
        )}

        <div className="mypage-section">
          <h2>활성 세션</h2>
          <p className="mypage-hint">
            최근 로그인 기록 — IP / User-Agent / 시각.  의심스러운 항목이
            있으면 아래 버튼으로 다른 디바이스 토큰을 모두 끊고 다시
            로그인하세요.
          </p>
          {sessions.length === 0 ? (
            <p className="mypage-hint">
              아직 로그인 기록이 없거나 로그를 가져올 수 없어요.
            </p>
          ) : (
            <ul className="audit-list">
              {sessions.map((s) => (
                <li key={s.id}>
                  <span className={`audit-badge audit-${s.active ? "ok" : "stale"}`}>
                    {s.active ? "활성" : "끊김"}
                  </span>
                  <span className="audit-time">
                    {s.created_at
                      ? new Date(s.created_at).toLocaleString("ko-KR")
                      : "—"}
                  </span>
                  <span className="audit-meta">
                    {s.ip}
                    {s.user_agent && ` · ${s.user_agent.slice(0, 80)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mypage-form-row" style={{ marginTop: 8 }}>
            <button
              className="logout"
              onClick={revokeOtherDevices}
              disabled={revoking}
              type="button"
            >
              {revoking ? "끊는 중…" : "🚪 다른 디바이스 모두 로그아웃"}
            </button>
          </div>
        </div>

        <div className="mypage-section mypage-danger">
          <h2>위험 구역</h2>
          <p>
            계정과 모든 대화 내역을 영구 삭제합니다. 되돌릴 수 없습니다.
          </p>
          <div className="mypage-form-row">
            <button className="logout" onClick={logout}>
              로그아웃
            </button>
            <button className="danger" onClick={deleteAccount}>
              계정 삭제
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function labelFor(event: string): string {
  switch (event) {
    case "signup":
      return "가입";
    case "login_ok":
      return "로그인";
    case "login_fail":
      return "로그인 실패";
    case "password_change":
      return "비번 변경";
    case "name_change":
      return "이름 변경";
    case "account_delete":
      return "계정 삭제";
    case "signup_fail":
      return "가입 실패";
    default:
      return event;
  }
}


// ── API 키 발급 (#45) ──────────────────────────────────────
// 외부 시스템 (워크플로 자동화·사내 봇 등) 이 X-API-Key 헤더로 호출.
function ApiKeysPanel() {
  type Key = {
    id: string;
    label: string;
    token_prefix: string;
    last_used_at: string | null;
    expires_at: string | null;
    created_at: string | null;
  };
  const [keys, setKeys] = useState<Key[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<{ token: string; label: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setKeys(await api.listApiKeys());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api.createApiKey(label, null);
      setIssued({ token: r.token, label: r.label });
      setLabel("");
      await refresh();
    } catch (e) {
      errorToast("발급 실패", e);
    }
  }
  async function revoke(id: string) {
    if (!window.confirm("이 키를 회수할까요?  외부 시스템에서 더 이상 동작하지 않게 됩니다.")) return;
    try {
      await api.revokeApiKey(id);
      await refresh();
    } catch (e) {
      errorToast("회수 실패", e);
    }
  }

  return (
    <div>
      <p className="mypage-hint">
        외부 시스템에서 `X-API-Key: aichat_...` 헤더로 호출하면 본인 권한
        으로 동작합니다. 발급된 토큰은 *한 번만* 노출되니 별도로 안전한
        곳에 보관하세요.
      </p>
      <form className="apikey-form" onSubmit={create}>
        <input
          placeholder="키 라벨 (예: n8n 워크플로)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={80}
        />
        <button type="submit" className="apikey-create">
          + 새 키 발급
        </button>
      </form>
      {issued && (
        <div className="apikey-issued">
          <div className="apikey-issued-head">
            새 키 발급됨 — 이 화면을 닫으면 다시 볼 수 없어요.
          </div>
          <div className="apikey-issued-token">{issued.token}</div>
          <div className="apikey-issued-actions">
            <button
              type="button"
              onClick={() => {
                void copyText(issued.token, "아래 API 키를 복사하세요");
              }}
            >
              복사
            </button>
            <button type="button" onClick={() => setIssued(null)}>
              닫기
            </button>
          </div>
        </div>
      )}
      {err && <div className="mypage-flash error">{err}</div>}
      {loading ? (
        <p className="mypage-hint">불러오는 중…</p>
      ) : keys.length === 0 ? (
        <p className="mypage-hint">발급된 키가 없어요.</p>
      ) : (
        <table className="apikey-table">
          <thead>
            <tr>
              <th>라벨</th>
              <th>접두 8자</th>
              <th>마지막 사용</th>
              <th>만료</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.label || "(라벨 없음)"}</td>
                <td>
                  <code>{k.token_prefix}…</code>
                </td>
                <td>
                  {k.last_used_at
                    ? new Date(k.last_used_at).toLocaleString()
                    : "—"}
                </td>
                <td>
                  {k.expires_at
                    ? new Date(k.expires_at).toLocaleDateString()
                    : "무기한"}
                </td>
                <td>
                  <button
                    type="button"
                    className="apikey-revoke"
                    onClick={() => revoke(k.id)}
                  >
                    회수
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
