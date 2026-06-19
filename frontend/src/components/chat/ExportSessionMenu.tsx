/** 세션 내보내기 메뉴 — DOCX / HWPX + PII 마스킹 + 범위(전체/요약/별표). */
import { useState } from "react";
import { api } from "../../api/client";
import { errorToast } from "../../lib/toast";
import { IconDownload } from "../Icon";

export function ExportSessionMenu({ sessionId, title }: { sessionId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [maskPii, setMaskPii] = useState(false);
  const [format, setFormat] = useState<"docx" | "hwpx">("docx");
  async function download(include: "all" | "summary" | "starred") {
    setBusy(true);
    setOpen(false);
    try {
      if (format === "hwpx") {
        await api.exportSessionHwpx(sessionId, title, include, maskPii);
      } else {
        await api.exportSessionDocx(sessionId, title, include, maskPii);
      }
    } catch (e) {
      errorToast("내보내기 실패", e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="export-menu-wrap" onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="panel-toggle"
        onClick={() => setOpen(v => !v)}
        disabled={busy}
        title="대화를 문서 파일로 내보내기"
      >
        <IconDownload size={14} /> {busy ? "내보내는 중…" : "내보내기"}
      </button>
      {open && (
        <div className="export-menu" role="menu">
          <div
            className="export-menu-format"
            onClick={(e) => e.stopPropagation()}
            title="DOCX = Word / Google Docs / Hangul 모두 호환. HWPX = 한컴오피스 네이티브."
          >
            <button
              type="button"
              className={`export-menu-format-tab${format === "docx" ? " active" : ""}`}
              onClick={() => setFormat("docx")}
            >
              .docx
            </button>
            <button
              type="button"
              className={`export-menu-format-tab${format === "hwpx" ? " active" : ""}`}
              onClick={() => setFormat("hwpx")}
            >
              .hwpx
            </button>
          </div>
          <label
            className="export-menu-toggle"
            onClick={(e) => e.stopPropagation()}
            title="주민번호 · 전화 · 이메일 · 카드 · 여권번호 자동 마스킹"
          >
            <input
              type="checkbox"
              checked={maskPii}
              onChange={(e) => setMaskPii(e.target.checked)}
            />
            <span>개인정보 마스킹</span>
          </label>
          <button type="button" onClick={() => download("all")}>📄 전체 대화</button>
          <button type="button" onClick={() => download("summary")}>🤖 어시스턴트 답변만</button>
          <button type="button" onClick={() => download("starred")}>★ 별표한 메시지만</button>
        </div>
      )}
    </div>
  );
}

/**
 * 인용 정확도 칩 — cosine similarity 점수를 사람이 읽기 쉬운 색·라벨
 * 로 매핑. 임계값은 bge-m3 기준 경험치이고 운영하면서 튜닝 가능.
 */
export function CitationChip({ score }: { score: number }) {
  // 점수 → 신뢰도 라벨 + 색깔. 임계값은 임베딩 모델 따라 조정.
  let tone: "high" | "mid" | "low" = "low";
  let label = "낮음";
  if (score >= 0.7) {
    tone = "high";
    label = "높음";
  } else if (score >= 0.45) {
    tone = "mid";
    label = "보통";
  }
  const pct = Math.round(score * 100);
  return (
    <span
      className={`citation-chip citation-${tone}`}
      title={`코사인 유사도 ${score.toFixed(3)} — 답변에 인용된 청크와 질문의 의미 유사도`}
    >
      {label} {pct}%
    </span>
  );
}
