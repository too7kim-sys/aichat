/** 시스템 헬스 인디케이터 (#39) — 관리자 헤더의 작은 점등.
 *  Ollama / Qdrant / DB / 최근 에러 카운트.  30초 자동 갱신.
 *  데이터가 안 와도 페이지 자체는 정상 동작. */
import { useEffect, useState } from "react";
import { admin } from "../../api/client";

export function HealthIndicator() {
  type Data = Awaited<ReturnType<typeof admin.health>>;
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await admin.health();
        if (!cancelled) setData(r);
      } catch {
        if (!cancelled) setData(null);
      }
    }
    void tick();
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  if (!data) return null;
  const overall =
    data.ollama.ok && data.qdrant.ok && data.db.ok && data.errors_24h < 5;
  const status = overall ? "ok" : data.db.ok ? "warn" : "err";
  return (
    <div className={`admin-health admin-health-${status}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="시스템 헬스 — 클릭해 자세히"
      >
        <span className="admin-health-dot" /> 헬스
      </button>
      {open && (
        <div className="admin-health-pop">
          <Row k="Ollama" v={data.ollama} />
          <Row k="Qdrant" v={data.qdrant} />
          <Row k="DB" v={data.db} />
          <div className="admin-health-row">
            <span>24시간 오류</span>
            <b>{data.errors_24h.toLocaleString()}</b>
          </div>
          <div className="admin-health-checked">
            점검: {new Date(data.checked_at).toLocaleTimeString()}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: { ok: boolean; latency_ms?: number; error?: string } }) {
  return (
    <div className="admin-health-row">
      <span>
        {v.ok ? "✓" : "✕"} {k}
      </span>
      <b>{v.ok ? `${v.latency_ms ?? "?"}ms` : v.error || "fail"}</b>
    </div>
  );
}
