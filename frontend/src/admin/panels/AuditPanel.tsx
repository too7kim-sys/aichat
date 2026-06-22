/** 감사 로그 뷰어 — event / 이메일 / 날짜 범위 필터 + CSV 내보내기. */
import { useEffect, useMemo, useState } from "react";
import { admin } from "../../api/client";
import { errorToast } from "../../lib/toast";

/** 백엔드 audit.record 의 event code → 한글 라벨.  알 수 없는 코드는
 *  원본을 그대로 보여줘 새 이벤트가 추가돼도 화면이 깨지지 않게. */
const EVENT_LABELS: Record<string, string> = {
  signup: "회원가입",
  signup_fail: "가입 실패",
  login_ok: "로그인",
  login_fail: "로그인 실패",
  password_change: "비밀번호 변경",
  name_change: "이름 변경",
  account_delete: "계정 삭제",
  user_approved: "사용자 승인",
  user_rejected: "사용자 거절",
  user_role_changed: "역할 변경",
  user_roles_changed: "역할(추가) 변경",
  user_suspended: "계정 정지",
  user_unsuspended: "정지 해제",
  role_created: "역할 생성",
  role_updated: "역할 수정",
  role_deleted: "역할 삭제",
  settings_changed: "설정 변경",
};

function eventLabel(code: string): string {
  return EVENT_LABELS[code] ?? code;
}

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

  // 현재 화면에 잡힌 행들로 이벤트별 카운트 — 칩 클릭으로 그 이벤트만
  // 필터하도록 한다. 빠르게 "오늘 로그인 몇 건" 같은 감을 보여주는
  // 용도라 서버에 별도 집계 호출은 하지 않는다.
  const eventCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.event, (m.get(r.event) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

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

      {/* 현재 결과의 이벤트별 카운트 칩 — 클릭으로 필터.  rows.length 가
          0 이면 숨김. */}
      {rows.length > 0 && (
        <div className="admin-audit-chips" role="group" aria-label="이벤트 빠른 필터">
          <button
            type="button"
            className={`admin-audit-chip${!event ? " active" : ""}`}
            onClick={() => { setEvent(""); refresh(); }}
            title="모든 이벤트"
          >
            전체 <b>{rows.length}</b>
          </button>
          {eventCounts.map(([code, n]) => (
            <button
              type="button"
              key={code}
              className={`admin-audit-chip${event === code ? " active" : ""}`}
              onClick={() => { setEvent(code); refresh(); }}
              title={code}
            >
              {eventLabel(code)} <b>{n}</b>
            </button>
          ))}
        </div>
      )}

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
              <th style={{ width: "16%" }}>이벤트</th>
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
                <td title={r.event}>
                  <span className="admin-audit-event">{eventLabel(r.event)}</span>
                </td>
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
