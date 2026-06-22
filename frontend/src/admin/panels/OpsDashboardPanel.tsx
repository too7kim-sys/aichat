/** 운영 대시보드 — 시스템 자원·모델 사용·사용자 활동·백업을 한 화면.
 *  네 섹션을 묶은 컨테이너 + 각 sub-panel 정의. */
import { useEffect, useState } from "react";
import { admin } from "../../api/client";
import { errorToast } from "../../lib/toast";
import { fmtBytes, SectionCard, Stat } from "./_shared";

export function OpsDashboardPanel() {
  return (
    <div className="admin-errors">
      <div className="admin-errors-head">
        <div>
          <h2>운영 대시보드</h2>
          <p>시스템 자원·모델 사용·사용자 활동·백업을 한 화면에서 확인합니다.</p>
        </div>
      </div>
      <SystemResourcesPanel />
      <ActivityTimelinePanel />
      <ModelUsagePanel />
      <UserActivityPanel />
      <BackupsPanel />
    </div>
  );
}

function SystemResourcesPanel() {
  type Snap = Awaited<ReturnType<typeof admin.systemResources>>;
  const [snap, setSnap] = useState<Snap | null>(null);
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const s = await admin.systemResources();
        if (alive) setSnap(s);
      } catch { /* ignore */ }
    }
    tick();
    const id = window.setInterval(tick, 5000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  if (!snap) return <SectionCard title="시스템 자원">불러오는 중…</SectionCard>;

  return (
    <SectionCard title="시스템 자원 (5초마다 갱신)">
      <div className="ops-grid">
        <Stat label="CPU 사용률" value={`${snap.cpu.percent.toFixed(1)}%`}
              note={`${snap.cpu.cores} cores${snap.cpu.load_avg.length ? ` · load ${snap.cpu.load_avg.map(n=>n.toFixed(2)).join("/")}` : ""}`}
              pct={snap.cpu.percent} />
        <Stat label="메모리" value={`${snap.memory.pct.toFixed(1)}%`}
              note={`${fmtBytes(snap.memory.used)} / ${fmtBytes(snap.memory.total)}`}
              pct={snap.memory.pct} />
        {snap.disks.map((d) => (
          <Stat
            key={d.path}
            label={`디스크 ${d.path}`}
            value={d.error ? "—" : `${d.pct?.toFixed(1)}%`}
            note={d.error ? d.error : `${fmtBytes(d.used ?? 0)} / ${fmtBytes(d.total ?? 0)}`}
            pct={d.pct ?? 0}
          />
        ))}
      </div>
      {snap.gpu && snap.gpu.length > 0 && (
        <table className="admin-table admin-error-table" style={{ marginTop: 12 }}>
          <thead>
            <tr><th>GPU</th><th>모델</th><th>사용률</th><th>메모리</th><th>온도</th></tr>
          </thead>
          <tbody>
            {snap.gpu.map((g) => (
              <tr key={g.index}>
                <td>#{g.index}</td>
                <td>{g.name}</td>
                <td>{g.utilization_pct}%</td>
                <td>{g.memory_used_mb} / {g.memory_total_mb} MB</td>
                <td>{g.temperature_c}°C</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

/** 활동 추이 — DAU/WAU/MAU 스탯 + 일별 로그인·메시지 sparkline.
 *  audit_log 의 login_ok 와 user-역할 메시지의 createed_at 시계열을
 *  합쳐 운영자가 추세를 한 눈에 볼 수 있게 한다. */
function ActivityTimelinePanel() {
  type Tl = Awaited<ReturnType<typeof admin.activityTimeline>>;
  const [tl, setTl] = useState<Tl | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  async function refresh() {
    setLoading(true);
    try { setTl(await admin.activityTimeline(days)); }
    catch { /* ignore */ }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [days]);

  return (
    <SectionCard
      title={`활동 추이 (최근 ${days}일)`}
      right={
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>최근 7일</option>
          <option value={14}>최근 14일</option>
          <option value={30}>최근 30일</option>
          <option value={90}>최근 90일</option>
        </select>
      }
    >
      {loading && !tl ? (
        <div className="admin-empty">불러오는 중…</div>
      ) : !tl ? (
        <div className="admin-empty">불러올 수 없어요.</div>
      ) : (
        <>
          <div className="ops-grid">
            <Stat label="DAU (24h)" value={String(tl.dau)}
                  note="최근 24시간 안에 로그인하거나 메시지를 보낸 고유 사용자 수" />
            <Stat label="WAU (7d)" value={String(tl.wau)}
                  note="최근 7일 안에 활동한 고유 사용자 수" />
            <Stat label="MAU (30d)" value={String(tl.mau)}
                  note="최근 30일 안에 활동한 고유 사용자 수" />
          </div>
          <Sparkline
            label="일별 로그인"
            values={tl.daily.map((d) => d.logins)}
            labels={tl.daily.map((d) => d.day)}
            color="#3b82f6"
          />
          <Sparkline
            label="일별 메시지"
            values={tl.daily.map((d) => d.messages)}
            labels={tl.daily.map((d) => d.day)}
            color="#10b981"
          />
          <Sparkline
            label="일별 활성 사용자"
            values={tl.daily.map((d) => d.active_users)}
            labels={tl.daily.map((d) => d.day)}
            color="#f59e0b"
          />
        </>
      )}
    </SectionCard>
  );
}

/** 라이브러리 없는 가벼운 SVG sparkline + bar + 최댓값 라벨.
 *  너비는 컨테이너에 100%, 높이는 고정 — 작은 추세 시각화 용도. */
function Sparkline({
  label, values, labels, color,
}: {
  label: string;
  values: number[];
  labels: string[];
  color: string;
}) {
  const max = Math.max(1, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  const W = 600;
  const H = 60;
  const step = values.length > 1 ? W / (values.length - 1) : W;
  const pts = values
    .map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * (H - 6) - 3).toFixed(1)}`)
    .join(" ");
  return (
    <div className="ops-sparkline">
      <div className="ops-sparkline-head">
        <span className="ops-sparkline-label">{label}</span>
        <span className="ops-sparkline-summary">
          합계 <b>{total.toLocaleString()}</b> · 최댓값 <b>{max.toLocaleString()}</b>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="ops-sparkline-svg"
        role="img"
        aria-label={`${label} ${values.length}일 추이`}
      >
        <polyline
          points={pts}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
        />
        {values.map((v, i) => (
          <circle
            key={i}
            cx={(i * step).toFixed(1)}
            cy={(H - (v / max) * (H - 6) - 3).toFixed(1)}
            r={1.6}
            fill={color}
          >
            <title>{`${labels[i]}: ${v.toLocaleString()}`}</title>
          </circle>
        ))}
      </svg>
      <div className="ops-sparkline-axis">
        <span>{labels[0]}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>
    </div>
  );
}


function ModelUsagePanel() {
  type Row = Awaited<ReturnType<typeof admin.modelUsage>>[number];
  const [rows, setRows] = useState<Row[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  async function refresh() {
    setLoading(true);
    try { setRows(await admin.modelUsage(days)); }
    catch { /* ignore */ }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [days]);

  const totalCost = rows.reduce((a, r) => a + r.estimated_cost_krw, 0);
  const totalTokens = rows.reduce((a, r) => a + r.tokens_out, 0);

  return (
    <SectionCard
      title={`모델별 사용 통계 (최근 ${days}일)`}
      right={
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>최근 7일</option>
          <option value={30}>최근 30일</option>
          <option value={90}>최근 90일</option>
        </select>
      }
    >
      {loading ? (
        <div className="admin-empty">불러오는 중…</div>
      ) : rows.length === 0 ? (
        <div className="admin-empty admin-empty-soft">
          선택한 기간에 모델 호출 기록이 없어요.  기간을 늘리거나 채팅이
          몇 건 쌓인 후 다시 확인해 보세요.
        </div>
      ) : (
        <>
          <table className="admin-table admin-error-table">
            <thead>
              <tr>
                <th>모델</th><th>호출</th><th>출력 토큰</th>
                <th>평균 지연</th><th>출력 단가 (₩/1k)</th><th>추정 비용 (₩)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.provider}>
                  <td><code>{r.provider}</code></td>
                  <td>{r.calls.toLocaleString()}</td>
                  <td>{r.tokens_out.toLocaleString()}</td>
                  <td>{r.avg_latency_ms.toLocaleString()} ms</td>
                  <td>{r.output_rate_krw_per_1k.toLocaleString()}</td>
                  <td>{r.estimated_cost_krw.toLocaleString()}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 600, borderTop: "2px solid var(--border)" }}>
                <td>합계</td>
                <td>{rows.reduce((a, r) => a + r.calls, 0).toLocaleString()}</td>
                <td>{totalTokens.toLocaleString()}</td>
                <td></td>
                <td></td>
                <td>{totalCost.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
          <div className="pm-help" style={{ marginTop: 6 }}>
            비용은 .env <code>MODEL_COST_RATES</code> 의 단가표를 기준으로 한 추정치입니다.
          </div>
        </>
      )}
    </SectionCard>
  );
}

function UserActivityPanel() {
  type Row = Awaited<ReturnType<typeof admin.userActivity>>[number];
  const [rows, setRows] = useState<Row[]>([]);
  const [days, setDays] = useState(30);
  async function refresh() {
    try { setRows(await admin.userActivity(days, 100)); } catch { /* ignore */ }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [days]);

  return (
    <SectionCard
      title={`사용자별 활동 (최근 ${days}일)`}
      right={
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>최근 7일</option>
          <option value={30}>최근 30일</option>
          <option value={90}>최근 90일</option>
        </select>
      }
    >
      {rows.length === 0 ? (
        <div className="admin-empty admin-empty-soft">
          선택한 기간에 활동한 사용자가 없습니다.  기간을 늘려 보세요.
        </div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th>이메일</th><th>역할</th><th>세션</th><th>메시지</th>
              <th>출력 토큰</th><th>로그인</th><th>마지막 활동</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.user_id}>
                <td>{r.email}</td>
                <td><code>{r.role}</code></td>
                <td>{r.session_count}</td>
                <td>{r.msg_count.toLocaleString()}</td>
                <td>{r.tokens_out.toLocaleString()}</td>
                <td>{r.logins}</td>
                <td className="admin-error-when">
                  {r.last_message_at
                    ? new Date(r.last_message_at).toLocaleString()
                    : r.last_login_at
                    ? new Date(r.last_login_at).toLocaleString()
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

function BackupsPanel() {
  type Item = { name: string; size_bytes: number; mtime: string };
  const [items, setItems] = useState<Item[]>([]);
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await admin.listBackups();
      setItems(r.files);
      setDir(r.backup_dir);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => { refresh(); }, []);

  async function trigger() {
    setBusy(true);
    setErr(null);
    try {
      await admin.createBackup();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    if (!window.confirm(`${name} 백업을 삭제할까요?`)) return;
    try {
      await admin.deleteBackup(name);
      await refresh();
    } catch (e) {
      errorToast("작업 실패", e);
    }
  }

  async function downloadFull() {
    setBusy(true);
    setErr(null);
    try {
      await admin.downloadFullBackup();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="DB 백업"
      right={
        <>
          <button
            type="button"
            className="admin-btn"
            onClick={downloadFull}
            disabled={busy}
            title="SQLite + uploads 를 한 zip 으로 다운로드 (#106)"
            style={{ marginRight: 6 }}
          >
            📦 전체 백업 zip
          </button>
          <button type="button" className="admin-btn" onClick={trigger} disabled={busy}>
            {busy ? "백업 중…" : "지금 백업"}
          </button>
        </>
      }
    >
      <div className="pm-help" style={{ marginBottom: 8 }}>
        디렉터리: <code>{dir || "(미설정)"}</code> · WAL 체크포인트 후 복사합니다.
      </div>
      {err && <div className="admin-empty admin-error">{err}</div>}
      {items.length === 0 ? (
        <div className="admin-empty">백업 파일이 없습니다.</div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr><th>이름</th><th>크기</th><th>시각</th><th></th></tr>
          </thead>
          <tbody>
            {items.map((b) => (
              <tr key={b.name}>
                <td><code>{b.name}</code></td>
                <td>{fmtBytes(b.size_bytes)}</td>
                <td className="admin-error-when">{new Date(b.mtime).toLocaleString()}</td>
                <td>
                  <a
                    href={`/api/admin/backups/${encodeURIComponent(b.name)}`}
                    onClick={(e) => {
                      // localStorage 토큰을 헤더로 못 박으니까 fetch 후
                      // blob 다운로드.
                      e.preventDefault();
                      void downloadAuthed(`/api/admin/backups/${encodeURIComponent(b.name)}`, b.name);
                    }}
                    className="admin-btn"
                    style={{ marginRight: 6 }}
                  >다운로드</a>
                  <button
                    type="button"
                    className="admin-btn admin-btn-danger"
                    onClick={() => remove(b.name)}
                  >삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

async function downloadAuthed(url: string, filename: string) {
  const token = localStorage.getItem("chat:token") || "";
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    errorToast(`다운로드 실패 (HTTP ${res.status})`);
    return;
  }
  const blob = await res.blob();
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(u);
}
