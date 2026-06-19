/** 답변 품질 패널 — 👎 받은 답변 + ⚠️ escalation inbox + 최근 30일
 *  통계 카드 (#121~#124).  사용자가 ⚠️ 를 누른 답변은 운영자가
 *  '✓ 처리됨' 으로 ack 한다. */
import { useEffect, useState } from "react";
import { admin, api } from "../../api/client";
import { errorToast } from "../../lib/toast";
import { FeedbackStat } from "./_shared";

export function QualityPanel() {
  type Row = Awaited<ReturnType<typeof admin.listDisliked>>[number];
  type Esc = Awaited<ReturnType<typeof admin.listEscalations>>[number];
  type Stats = Awaited<ReturnType<typeof admin.feedbackStats>>;
  const [rows, setRows] = useState<Row[]>([]);
  const [escalations, setEscalations] = useState<Esc[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [tab, setTab] = useState<"disliked" | "escalated">("disliked");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [r, e, s] = await Promise.all([
        admin.listDisliked(100),
        admin.listEscalations({ limit: 100, onlyOpen: true }),
        admin.feedbackStats(30),
      ]);
      setRows(r);
      setEscalations(e);
      setStats(s);
      setErr(null);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refresh(); }, []);

  async function ack(sessId: string, msgId: string) {
    try {
      await api.ackEscalation(sessId, msgId);
      await refresh();
    } catch (e) {
      errorToast("작업 실패", e);
    }
  }

  if (loading && !stats) return <div className="admin-empty">불러오는 중…</div>;
  if (err) return <div className="admin-empty admin-error">{err}</div>;

  return (
    <div className="admin-errors">
      <div className="admin-errors-head">
        <div>
          <h2>답변 품질</h2>
          <p>
            👎 / ⚠️ escalation / 별점을 한 화면에서 점검. 최근 30일 통계 +
            상세 목록.
          </p>
        </div>
      </div>

      {stats && (
        <div className="admin-policy" style={{ display: "block", marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 16, padding: "8px 0" }}>
            <FeedbackStat label="AI 답변" value={stats.total_assistant_messages} />
            <FeedbackStat label="👍" value={stats.up} tone="ok" />
            <FeedbackStat label="👎" value={stats.down} tone="warn" />
            <FeedbackStat label="⚠️ Escalation" value={stats.escalated} tone="err" />
          </div>
          {Object.keys(stats.down_by_category).length > 0 && (
            <div className="pm-help">
              👎 사유: {Object.entries(stats.down_by_category)
                .map(([k, v]) => `${k} ${v}`)
                .join(" · ")}
            </div>
          )}
          {Object.values(stats.by_rating).some((n) => n > 0) && (
            <div className="pm-help">
              별점: {[5, 4, 3, 2, 1]
                .map((n) => `${n}★ ${stats.by_rating[String(n)] ?? 0}`)
                .join(" · ")}
            </div>
          )}
        </div>
      )}

      <div className="admin-controls">
        <div className="admin-tabs" role="tablist">
          <button
            role="tab"
            className={`admin-tab${tab === "disliked" ? " active" : ""}`}
            onClick={() => setTab("disliked")}
          >
            👎 싫어요 ({rows.length})
          </button>
          <button
            role="tab"
            className={`admin-tab${tab === "escalated" ? " active" : ""}`}
            onClick={() => setTab("escalated")}
          >
            ⚠️ Escalation ({escalations.length})
          </button>
        </div>
        <button type="button" className="admin-btn" onClick={refresh}>
          새로고침
        </button>
      </div>

      {tab === "escalated" ? (
        escalations.length === 0 ? (
          <div className="admin-empty admin-empty-soft">
            ✓ 사용자가 '⚠️ AI 가 못 풀었어요' 로 표시한 답변이 아직 없습니다.
            <div className="pm-help" style={{ marginTop: 4 }}>
              사용자가 답변 옆 ⚠️ 버튼을 누르면 여기 모이고 관리자에게 알림이
              발송됩니다.
            </div>
          </div>
        ) : (
          <table className="admin-table admin-error-table">
            <thead>
              <tr>
                <th>요청 시각</th>
                <th>사용자</th>
                <th>세션</th>
                <th>사유</th>
                <th>답변 미리보기</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {escalations.map((r) => (
                <tr key={r.message_id}>
                  <td className="admin-error-when">
                    {r.escalated_at ? new Date(r.escalated_at).toLocaleString() : "—"}
                  </td>
                  <td>{r.user_email}</td>
                  <td>
                    <a
                      href={`?session=${r.session_id}&message=${r.message_id}`}
                      title="이 세션으로 이동"
                    >
                      {r.session_title}
                    </a>
                  </td>
                  <td>
                    {r.reason ? (
                      <div className="admin-quality-note">{r.reason}</div>
                    ) : (
                      <span className="admin-cell-muted">(사유 없음)</span>
                    )}
                  </td>
                  <td>
                    <div className="admin-quality-snippet">{r.content}</div>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="admin-btn"
                      onClick={() => ack(r.session_id, r.message_id)}
                      title="처리 완료 표시"
                    >
                      ✓ 처리됨
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : rows.length === 0 ? (
        <div className="admin-empty">✓ 최근 싫어요 표시된 답변이 없습니다.</div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th>사용자</th>
              <th>세션</th>
              <th>답변</th>
              <th>사유</th>
              <th>별점</th>
              <th>메모</th>
              <th>시각</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.message_id}>
                <td>{r.user_email}</td>
                <td>
                  <a
                    href={`?session=${r.session_id}&message=${r.message_id}`}
                    title="이 세션으로 이동"
                  >
                    {r.session_title}
                  </a>
                </td>
                <td>
                  <div className="admin-quality-snippet">{r.content}</div>
                  {r.provider && (
                    <div className="admin-quality-meta">{r.provider}</div>
                  )}
                </td>
                <td>
                  {r.feedback_category ? (
                    <code>{r.feedback_category}</code>
                  ) : (
                    <span className="admin-cell-muted">—</span>
                  )}
                </td>
                <td>
                  {r.rating ? "★".repeat(r.rating) : <span className="admin-cell-muted">—</span>}
                </td>
                <td>
                  {r.feedback_note ? (
                    <div className="admin-quality-note">{r.feedback_note}</div>
                  ) : (
                    <span className="admin-cell-muted">—</span>
                  )}
                </td>
                <td>
                  {r.created_at
                    ? new Date(r.created_at).toLocaleString()
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
