/** Admin 패널들이 공유하는 작은 컴포넌트.  AdminPage 가 3K+ 줄이라
 *  큰 패널을 별 파일로 떼면서, 매 파일에 같은 helper 를 중복으로
 *  넣지 않도록 모아둠.  새 패널이 SectionCard / Stat / fmtBytes /
 *  FeedbackStat 가 필요하면 여기에서 import. */
import type React from "react";

export function SectionCard({
  title, right, children,
}: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="admin-error-section" style={{ marginTop: 18 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3>{title}</h3>
        {right}
      </header>
      <div>{children}</div>
    </section>
  );
}

export function Stat({ label, value, note, pct }: {
  label: string; value: string; note: string;
  /** 0~100 사용률 막대.  undefined 면 막대 자체를 숨김 (DAU/WAU 같이
   *  비율이 의미 없는 절대값 카드용). */
  pct?: number;
}) {
  const tone = pct == null
    ? "ok"
    : pct > 85 ? "danger"
    : pct > 70 ? "warn"
    : "ok";
  return (
    <div className={`ops-stat ops-${tone}`}>
      <div className="ops-stat-label">{label}</div>
      <div className="ops-stat-value">{value}</div>
      {pct != null && (
        <div className="ops-stat-bar">
          <div className="ops-stat-bar-fill" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
      <div className="ops-stat-note">{note}</div>
    </div>
  );
}

export function fmtBytes(n: number): string {
  if (!n) return "0";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}

/** 답변 품질 카드 — 큰 숫자 + 라벨 + 톤.  Stat 와 형식이 달라 별도. */
export function FeedbackStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "warn" | "err";
}) {
  const color =
    tone === "ok" ? "#15803d"
    : tone === "warn" ? "#a16207"
    : tone === "err" ? "#b91c1c"
    : "inherit";
  return (
    <div style={{ flex: 1, textAlign: "center" }}>
      <div style={{ fontSize: 22, fontWeight: 600, color }}>
        {value.toLocaleString()}
      </div>
      <div className="pm-help" style={{ marginTop: 2 }}>{label}</div>
    </div>
  );
}
