/** 사용자별 사용량 (#41) — 최근 N일 동안의 메시지·토큰·평균 응답 시간. */
import { useEffect, useState } from "react";
import { admin } from "../../api/client";

export function UsagePanel() {
  type Data = Awaited<ReturnType<typeof admin.listUsage>>;
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function refresh(d: number) {
    setLoading(true);
    try {
      const r = await admin.listUsage(d);
      setData(r);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh(days);
  }, [days]);

  if (loading) return <div className="admin-empty">불러오는 중…</div>;
  if (err) return <div className="admin-empty admin-error">{err}</div>;
  if (!data) return null;
  return (
    <div className="admin-errors">
      <div className="admin-errors-head">
        <div>
          <h2>📈 사용자별 사용량</h2>
          <p>
            최근 {data.days} 일 — 메시지 수 / 출력 토큰 / 평균 응답 시간 /
            마지막 활동.
          </p>
        </div>
        <div className="admin-usage-range">
          {[7, 30, 90, 365].map((d) => (
            <button
              key={d}
              type="button"
              className={`admin-tab${days === d ? " active" : ""}`}
              onClick={() => setDays(d)}
            >
              {d}일
            </button>
          ))}
        </div>
      </div>
      {data.items.length === 0 ? (
        <div className="admin-empty">최근 사용 기록이 없어요.</div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th>사용자</th>
              <th>메시지</th>
              <th>출력 토큰</th>
              <th>평균 응답</th>
              <th>마지막 활동</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.user_id}>
                <td>
                  <div className="admin-user-name">{r.name || r.email}</div>
                  <div className="admin-user-email">{r.email}</div>
                </td>
                <td>{r.message_count.toLocaleString()}</td>
                <td>{r.tokens_out_sum.toLocaleString()}</td>
                <td>
                  {r.avg_latency_ms != null
                    ? `${(r.avg_latency_ms / 1000).toFixed(1)}s`
                    : "—"}
                </td>
                <td>
                  {r.last_activity
                    ? new Date(r.last_activity).toLocaleString()
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
