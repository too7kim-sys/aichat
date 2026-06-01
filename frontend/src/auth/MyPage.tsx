import { useState, type FormEvent } from "react";
import { auth } from "../api/client";
import { useAuth } from "./AuthContext";

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
    if (newPw.length < 8) {
      setError("새 비밀번호는 8자 이상이어야 합니다");
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
            placeholder="새 비밀번호 (8자 이상)"
            autoComplete="new-password"
            minLength={8}
            required
          />
          <button className="primary" type="submit" disabled={saving}>
            비밀번호 변경
          </button>
        </form>

        {(message || error) && (
          <div className={`mypage-flash ${error ? "error" : "ok"}`}>
            {error || message}
          </div>
        )}

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
