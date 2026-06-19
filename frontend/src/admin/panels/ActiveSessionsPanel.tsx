/** 활성 세션 + 강제 로그아웃 — JWT 가 stateless 라 정확한 '활성 토큰'
 *  목록은 불가능, 마지막 로그인 시각이 토큰 컷오프 이후인 사용자를
 *  근사로 표시.  강제 로그아웃은 그 사용자의 모든 토큰을 즉시 만료. */
import { useEffect, useState } from "react";
import { admin } from "../../api/client";
import { errorToast } from "../../lib/toast";

export function ActiveSessionsPanel() {
  type Row = Awaited<ReturnType<typeof admin.listActiveSessions>>[number];
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const r = await admin.listActiveSessions();
      setRows(r);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refresh(); }, []);

  async function forceLogout(r: Row) {
    if (!window.confirm(`${r.email} 의 모든 활성 토큰을 즉시 무효화합니다.\n계속할까요?`)) return;
    setBusyId(r.user_id);
    try {
      await admin.forceLogoutUser(r.user_id);
      await refresh();
    } catch (e) {
      errorToast("실패", e);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="admin-errors">
      <div className="admin-errors-head">
        <div>
          <h2>활성 세션</h2>
          <p>
            마지막 로그인 시각이 토큰 무효화 시점보다 이후인 사용자입니다.
            강제 로그아웃을 누르면 해당 사용자의 모든 JWT 가 즉시 만료됩니다.
          </p>
        </div>
        <button type="button" className="admin-btn" onClick={refresh}>새로고침</button>
      </div>
      {loading ? (
        <div className="admin-empty">불러오는 중…</div>
      ) : err ? (
        <div className="admin-empty admin-error">오류: {err}</div>
      ) : rows.length === 0 ? (
        <div className="admin-empty">현재 활성 세션이 없습니다.</div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th>이메일</th>
              <th>역할</th>
              <th>마지막 로그인</th>
              <th>마지막 무효화</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.user_id}>
                <td>{r.email}</td>
                <td><code>{r.role}</code></td>
                <td className="admin-error-when">{new Date(r.last_login_at).toLocaleString()}</td>
                <td className="admin-error-when">
                  {r.tokens_invalidated_at
                    ? new Date(r.tokens_invalidated_at).toLocaleString()
                    : "—"}
                </td>
                <td>
                  <button
                    type="button"
                    className="admin-btn admin-btn-danger"
                    onClick={() => forceLogout(r)}
                    disabled={busyId === r.user_id}
                  >
                    {busyId === r.user_id ? "처리 중…" : "강제 로그아웃"}
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
