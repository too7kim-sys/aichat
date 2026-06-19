/** 관측/모니터링 패널 (#116~#120) — SLO 요약, 엔드포인트 통계,
 *  slow request, 외부 알림 webhook 발송 이력.  middleware 가 만든
 *  RequestLog 를 기반. */
import { useEffect, useState } from "react";
import { admin } from "../../api/client";
import { errorToast, infoToast } from "../../lib/toast";

export function MonitorPanel() {
  type Slo = Awaited<ReturnType<typeof admin.sloDashboard>>;
  type Slow = Awaited<ReturnType<typeof admin.listSlowRequests>>["items"][number];
  type Stats = Awaited<ReturnType<typeof admin.endpointStats>>["items"][number];
  type Hook = Awaited<ReturnType<typeof admin.listWebhooks>>[number];

  const [slo, setSlo] = useState<Slo | null>(null);
  const [slow, setSlow] = useState<Slow[]>([]);
  const [stats, setStats] = useState<Stats[]>([]);
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setErr(null);
    try {
      const [s, sl, st, h] = await Promise.all([
        admin.sloDashboard(),
        admin.listSlowRequests({ limit: 100 }),
        admin.endpointStats(hours),
        admin.listWebhooks(20),
      ]);
      setSlo(s);
      setSlow(sl.items);
      setStats(st.items);
      setHooks(h);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [hours]);

  async function sendTest() {
    try {
      await admin.testWebhook();
      infoToast("테스트 알림을 전송했어요 — 아래 '최근 발송' 표에서 결과를 확인하세요.");
      await refresh();
    } catch (e) {
      errorToast("작업 실패", e);
    }
  }

  // 트렌드를 간단한 ascii sparkline 으로.  bar chart 비용을 안 늘리려는
  // 의도 — 운영 대시보드 패널 그대로 두는 게 정보 밀도 ↑.
  function spark(values: number[], max?: number): string {
    if (values.length === 0) return "";
    const m = max ?? Math.max(...values, 1);
    const blocks = "▁▂▃▄▅▆▇█";
    return values
      .map((v) => blocks[Math.min(blocks.length - 1, Math.floor(v / m * (blocks.length - 1)))])
      .join("");
  }

  return (
    <div className="admin-errors">
      <div className="admin-errors-head">
        <div>
          <h2>관측/모니터링</h2>
          <p>
            요청 트레이싱 raw → SLO·slow request·엔드포인트 통계 + 외부
            알림 webhook.  모든 요청은 middleware 가 RequestLog 한 줄로
            남깁니다 (보존: 기본 7일).
          </p>
        </div>
        <button
          type="button"
          className="admin-btn"
          onClick={refresh}
          disabled={busy}
        >
          {busy ? "수집 중…" : "🔄 다시 수집"}
        </button>
      </div>

      {err && <div className="admin-empty admin-error">오류: {err}</div>}

      {slo && (
        <>
          <h3 style={{ marginTop: 18 }}>📈 SLO 요약 (#119)</h3>
          <table className="admin-table admin-error-table">
            <thead>
              <tr>
                <th>기간</th>
                <th>총 요청</th>
                <th>성공율</th>
                <th>5xx 비율</th>
                <th>평균 latency</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["최근 24시간", slo.h24],
                  ["최근 7일", slo.d7],
                ] as const
              ).map(([label, s]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>{s.total.toLocaleString()}</td>
                  <td style={{ color: s.success_pct >= 99 ? "#15803d" : s.success_pct >= 95 ? "#a16207" : "#b91c1c" }}>
                    {s.success_pct}%
                  </td>
                  <td>{s.error_5xx_pct}%</td>
                  <td>{s.avg_latency_ms}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pm-help" style={{ marginTop: 8 }}>
            <div>
              24h trend (요청 수):{" "}
              <code style={{ fontFamily: "monospace" }}>
                {spark(slo.trend_24h.map((t) => t.total))}
              </code>
            </div>
            <div>
              24h trend (avg latency ms):{" "}
              <code style={{ fontFamily: "monospace" }}>
                {spark(slo.trend_24h.map((t) => t.avg_latency_ms))}
              </code>
            </div>
            <div>
              7d trend (요청 수):{" "}
              <code style={{ fontFamily: "monospace" }}>
                {spark(slo.trend_7d.map((t) => t.total))}
              </code>
            </div>
          </div>
        </>
      )}

      <h3 style={{ marginTop: 18 }}>📊 엔드포인트별 통계 (#118)</h3>
      <div style={{ marginBottom: 8 }}>
        <select
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
        >
          <option value={1}>최근 1시간</option>
          <option value={24}>최근 24시간</option>
          <option value={168}>최근 7일</option>
        </select>
      </div>
      {stats.length === 0 ? (
        <div className="admin-empty admin-empty-soft">
          선택한 기간에 요청 기록이 없습니다.  middleware 가 자동으로 모든
          API 호출을 기록하므로 기간을 늘려 보세요.
        </div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th>메서드</th>
              <th>경로</th>
              <th>호출 수</th>
              <th>p50</th>
              <th>p95</th>
              <th>p99</th>
              <th>5xx 비율</th>
            </tr>
          </thead>
          <tbody>
            {stats.slice(0, 30).map((s) => (
              <tr key={`${s.method}-${s.path}`}>
                <td><code>{s.method}</code></td>
                <td><code>{s.path}</code></td>
                <td>{s.count}</td>
                <td>{s.p50}ms</td>
                <td>{s.p95}ms</td>
                <td>{s.p99}ms</td>
                <td style={{ color: s.error_rate_pct > 1 ? "#b91c1c" : "inherit" }}>
                  {s.error_rate_pct}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={{ marginTop: 18 }}>🐌 Slow request (#117)</h3>
      {slow.length === 0 ? (
        <div className="admin-empty">임계치를 넘긴 요청 없음</div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th>시각</th>
              <th>경로</th>
              <th>상태</th>
              <th>지연</th>
              <th>사용자</th>
            </tr>
          </thead>
          <tbody>
            {slow.slice(0, 30).map((r) => (
              <tr key={r.id}>
                <td className="admin-error-when">
                  {r.created_at ? new Date(r.created_at).toLocaleString() : "—"}
                </td>
                <td>
                  <code>{r.method} {r.path}</code>
                </td>
                <td>{r.status_code}</td>
                <td style={{ color: r.latency_ms > 2000 ? "#b91c1c" : "#a16207" }}>
                  {r.latency_ms}ms
                </td>
                <td>{r.user_email}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={{ marginTop: 18 }}>🔔 외부 알림 webhook (#120)</h3>
      <div style={{ marginBottom: 8 }}>
        <button
          type="button"
          className="admin-btn"
          onClick={sendTest}
          title="현재 webhook_alert_url 로 테스트 알림 전송"
        >
          🧪 테스트 알림 보내기
        </button>
      </div>
      {hooks.length === 0 ? (
        <div className="admin-empty">발송 이력 없음 (또는 webhook_alert_url 미설정)</div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th>시각</th>
              <th>종류</th>
              <th>제목</th>
              <th>상태</th>
              <th>응답 코드</th>
            </tr>
          </thead>
          <tbody>
            {hooks.map((h) => (
              <tr key={h.id}>
                <td className="admin-error-when">
                  {h.created_at ? new Date(h.created_at).toLocaleString() : "—"}
                </td>
                <td>{h.kind}</td>
                <td>{h.title}</td>
                <td style={{ color: h.status === "sent" ? "#15803d" : h.status === "failed" ? "#b91c1c" : "inherit" }}>
                  {h.status}
                  {h.error && <div style={{ fontSize: 10 }}>{h.error.slice(0, 80)}</div>}
                </td>
                <td>{h.response_code ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
