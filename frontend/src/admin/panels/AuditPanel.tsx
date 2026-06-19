/** 감사 로그 뷰어 — event / 이메일 / 날짜 범위 필터 + CSV 내보내기. */
import { useEffect, useState } from "react";
import { admin } from "../../api/client";
import { errorToast } from "../../lib/toast";

export function AuditPanel() {
  type Row = Awaited<ReturnType<typeof admin.listAudit>>[number];
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [event, setEvent] = useState("");
  const [userQ, setUserQ] = useState("");
  const [limit, setLimit] = useState(100);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  async function refresh() {
    setLoading(true);
    try {
      const r = await admin.listAudit({
        event: event || undefined,
        userQ: userQ || undefined,
        limit,
        dateFrom: dateFrom || undefined,
        // date_to 는 그 날의 23:59:59 까지 포함하도록 시각 부분을 붙여
        // 보냄 — 백엔드의 fromisoformat 이 미드나잇으로 해석해 그 날을
        // 통째로 빠뜨리는 일이 없게.
        dateTo: dateTo ? `${dateTo}T23:59:59` : undefined,
      });
      setRows(r);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  async function exportCsv() {
    try {
      await admin.exportAuditCsv({
        event: event || undefined,
        userQ: userQ || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo ? `${dateTo}T23:59:59` : undefined,
      });
    } catch (e) {
      errorToast("CSV 내보내기 실패", e);
    }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  return (
    <div className="admin-errors">
      <div className="admin-errors-head">
        <div>
          <h2>감사 로그</h2>
          <p>로그인·회원가입·비밀번호 변경·계정 삭제 등 사용자 활동 이력입니다.</p>
        </div>
      </div>
      <div className="admin-audit-filters">
        <input
          type="text"
          placeholder="이벤트 (예: login_ok)"
          value={event}
          onChange={(e) => setEvent(e.target.value.trim())}
          onKeyDown={(e) => { if (e.key === "Enter") refresh(); }}
        />
        <input
          type="text"
          placeholder="이메일 검색"
          value={userQ}
          onChange={(e) => setUserQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") refresh(); }}
        />
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          title="시작일 (포함)"
        />
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          title="종료일 (포함)"
        />
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          <option value={50}>최근 50</option>
          <option value={100}>최근 100</option>
          <option value={200}>최근 200</option>
          <option value={500}>최근 500</option>
        </select>
        <button type="button" className="admin-btn" onClick={refresh}>검색</button>
        <button
          type="button"
          className="admin-btn"
          onClick={exportCsv}
          title="현재 필터 조건의 결과를 CSV 로 (최대 1만 건)"
        >
          📥 CSV
        </button>
      </div>

      {loading ? (
        <div className="admin-empty">불러오는 중…</div>
      ) : err ? (
        <div className="admin-empty admin-error">오류: {err}</div>
      ) : rows.length === 0 ? (
        <div className="admin-empty admin-empty-soft">
          조건에 맞는 감사 로그가 없습니다.  필터(이벤트·이메일·날짜) 를
          비우면 최근 전체 활동이 보입니다.
        </div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th style={{ width: "16%" }}>시각</th>
              <th style={{ width: "12%" }}>이벤트</th>
              <th style={{ width: "20%" }}>사용자</th>
              <th style={{ width: "12%" }}>IP</th>
              <th>상세</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="admin-error-when">
                  {r.created_at ? new Date(r.created_at).toLocaleString() : "-"}
                </td>
                <td><code>{r.event}</code></td>
                <td className="admin-error-who" title={r.user_id ?? ""}>{r.user_email}</td>
                <td><code>{r.ip || "-"}</code></td>
                <td>{r.detail || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
