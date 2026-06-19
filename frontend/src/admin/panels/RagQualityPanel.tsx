/** RAG 검색 품질 (#111) — 검색 단계 토글 (rewrite/rerank/MMR) + 최근
 *  질의 품질 로그 (#110).  토글은 admin 만 변경 가능. */
import { useEffect, useState } from "react";
import { admin, type AppSettings } from "../../api/client";
import { errorToast } from "../../lib/toast";

export function RagQualityPanel({
  appSettings,
  setAppSettings,
  isAdmin,
}: {
  appSettings: AppSettings | null;
  setAppSettings: (s: AppSettings | null) => void;
  isAdmin: boolean;
}) {
  type Row = Awaited<ReturnType<typeof admin.listSearchQuality>>[number];
  const [rows, setRows] = useState<Row[]>([]);
  const [onlyMisses, setOnlyMisses] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await admin.listSearchQuality({
        onlyMisses,
        limit: 200,
      });
      setRows(r);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [onlyMisses]);

  async function toggle(key: keyof AppSettings, next: boolean) {
    if (!appSettings) return;
    setBusy(true);
    try {
      const updated = await admin.updateSettings({ [key]: next });
      setAppSettings(updated);
    } catch (e) {
      errorToast("작업 실패", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-errors">
      <div className="admin-errors-head">
        <div>
          <h2>RAG 검색 품질</h2>
          <p>
            검색 단계 토글 + 최근 질의 품질 로그. 변경은 즉시 반영되며 모든
            토글은 실패 시 자동 fallback 으로 검색 자체를 막지 않습니다.
          </p>
        </div>
      </div>
      {appSettings && (
        <div className="admin-policy" style={{ display: "block" }}>
          {(
            [
              ["rag_query_rewrite", "질의 재작성 (#107)", "짧은 질문을 LLM 이 풀어서 임베딩 정확도 ↑ (응답 +300ms)"],
              ["rag_llm_rerank", "LLM 재순위 (#108)", "top 후보를 LLM 이 0~10점 매겨 재정렬 (응답 +1~3s)"],
              ["rag_mmr", "MMR 다양성 (#109)", "같은 파일/유사 청크 중복을 자동 솎아 컨텍스트 효율 ↑"],
            ] as const
          ).map(([key, label, sub]) => {
            const on = appSettings[key as keyof AppSettings] as boolean;
            return (
              <div
                key={key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "8px 0",
                  borderBottom: "1px solid #eee",
                  gap: 12,
                }}
              >
                <div style={{ flex: 1 }}>
                  <div className="admin-policy-title">
                    {label}
                    <span
                      className={`admin-policy-badge ${
                        on ? "admin-policy-badge-on" : "admin-policy-badge-off"
                      }`}
                    >
                      {on ? "켜짐" : "꺼짐"}
                    </span>
                  </div>
                  <div className="admin-policy-sub">{sub}</div>
                </div>
                <label
                  className={`admin-policy-switch${isAdmin ? "" : " disabled"}`}
                  title={isAdmin ? undefined : "관리자만 변경할 수 있습니다"}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => toggle(key as keyof AppSettings, e.target.checked)}
                    disabled={!isAdmin || busy}
                  />
                  <span className="admin-policy-slider" />
                </label>
              </div>
            );
          })}
        </div>
      )}

      <div className="admin-audit-filters" style={{ marginTop: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={onlyMisses}
            onChange={(e) => setOnlyMisses(e.target.checked)}
          />
          잘 안 된 질의만 (결과 0개 또는 top score &lt; 0.3)
        </label>
        <button type="button" className="admin-btn" onClick={refresh}>
          새로고침
        </button>
      </div>

      {err ? (
        <div className="admin-empty admin-error">오류: {err}</div>
      ) : rows.length === 0 ? (
        <div className="admin-empty admin-empty-soft">
          검색 품질 로그가 아직 비어 있어요.  채팅에서 지식베이스 검색이
          한 번 일어나야 첫 행이 쌓입니다.
        </div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th style={{ width: "16%" }}>시각</th>
              <th>질의</th>
              <th style={{ width: "12%" }}>최고 점수</th>
              <th style={{ width: "8%" }}>건수</th>
              <th style={{ width: "10%" }}>지연</th>
              <th style={{ width: "18%" }}>사용자</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="admin-error-when">
                  {r.created_at ? new Date(r.created_at).toLocaleString() : "—"}
                </td>
                <td>
                  <code>{r.query}</code>
                </td>
                <td>
                  <span
                    style={{
                      color: r.top_score < 0.3 ? "#b91c1c" : "#15803d",
                    }}
                  >
                    {r.top_score.toFixed(3)}
                  </span>
                </td>
                <td>{r.hit_count}</td>
                <td>{r.elapsed_ms}ms</td>
                <td>{r.user_email}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
