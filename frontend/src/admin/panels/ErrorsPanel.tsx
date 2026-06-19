/** 최근 실패한 작업 — 전사·RAG·워크플로·백엔드 오류를 한 화면에 모아
 *  운영자가 SSH/로그 없이 점검.  30초 자동 갱신. */
import { useEffect, useState } from "react";
import { admin } from "../../api/client";

export function ErrorsPanel() {
  type Data = Awaited<ReturnType<typeof admin.listErrors>>;
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  async function refresh() {
    try {
      const r = await admin.listErrors(50);
      setData(r);
      setErr(null);
      setLastRefresh(new Date());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (loading) return <div className="admin-empty">불러오는 중…</div>;
  if (err)
    return <div className="admin-empty admin-error">오류: {err}</div>;
  if (!data) return null;

  const total =
    data.transcripts.length +
    data.projects.length +
    data.workflows.length +
    (data.app_errors?.length ?? 0);

  return (
    <div className="admin-errors">
      <div className="admin-errors-head">
        <div>
          <h2>최근 실패한 작업</h2>
          <p>
            전사 / RAG / 워크플로의 가장 최근 실패 기록을 한 화면에서
            확인합니다. 30초마다 자동 갱신.
            {lastRefresh && (
              <span className="admin-errors-stamp">
                {" "}· 최근 갱신: {lastRefresh.toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>
        <button type="button" className="admin-btn" onClick={refresh}>
          새로고침
        </button>
      </div>

      {total === 0 ? (
        <div className="admin-empty">
          ✓ 최근 실패한 작업이 없습니다.
        </div>
      ) : (
        <>
          <ErrorSection
            title={`전사(회의록) 실패 — ${data.transcripts.length}건`}
            empty="전사 실패 없음"
            rows={data.transcripts.map((t) => ({
              key: t.id,
              who: t.user_email,
              what: t.source_filename,
              when: t.updated_at,
              error: t.error,
            }))}
          />
          <ErrorSection
            title={`RAG 지식베이스 실패 — ${data.projects.length}건`}
            empty="RAG 실패 없음"
            rows={data.projects.map((p) => ({
              key: p.id,
              who: p.owner_email,
              what: `${p.name}  ·  ${p.source_type}`,
              when: p.updated_at,
              error: p.error,
            }))}
          />
          <ErrorSection
            title={`워크플로 실패 — ${data.workflows.length}건`}
            empty="워크플로 실패 없음"
            rows={data.workflows.map((w) => ({
              key: w.id,
              who: w.user_email,
              what: w.name,
              when: w.last_run_at,
              error: w.last_error,
            }))}
          />
          <ErrorSection
            title={`백엔드 일반 오류 — ${(data.app_errors ?? []).length}건`}
            empty="기록된 백엔드 오류 없음"
            rows={(data.app_errors ?? []).map((r) => ({
              key: r.id,
              who:
                r.user_email ??
                (r.ip ? `(익명 · ${r.ip})` : "(익명)"),
              what:
                `[${r.level}] ${r.source}` +
                (r.method && r.path
                  ? `  ${r.method} ${r.path}`
                  : "") +
                (r.status_code ? `  → ${r.status_code}` : ""),
              when: r.created_at,
              error: r.traceback
                ? `${r.message}\n\n${r.traceback}`
                : r.message,
            }))}
          />
        </>
      )}
    </div>
  );
}

function ErrorSection({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{
    key: string;
    who: string;
    what: string;
    when: string | null;
    error: string;
  }>;
}) {
  return (
    <section className="admin-error-section">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <div className="admin-empty admin-empty-soft">{empty}</div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th style={{ width: "16%" }}>사용자</th>
              <th style={{ width: "24%" }}>대상</th>
              <th style={{ width: "14%" }}>시각</th>
              <th>오류 메시지</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="admin-error-who" title={r.who}>{r.who}</td>
                <td className="admin-error-what" title={r.what}>{r.what}</td>
                <td className="admin-error-when">
                  {r.when ? new Date(r.when).toLocaleString() : "-"}
                </td>
                <td>
                  <code className="admin-error-msg">{r.error || "(메시지 없음)"}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
