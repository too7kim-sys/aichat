/** RAG 검색된 청크 박스 — 답변이 참조한 지식베이스 청크 목록.
 *  기본 접힘 (긴 답변에서 화면 차지 최소화), 클릭 시 펼침. */
import { useState } from "react";
import { api, type RagChunk } from "../../api/client";
import { errorToast } from "../../lib/toast";
import { CitationChip } from "./ExportSessionMenu";

export function RagChunksBox({
  chunks,
}: {
  chunks: RagChunk[];
}) {
  // Collapsed by default — users open it when they want to inspect
  // which chunks fed the answer, otherwise the list pushes the
  // generated text off-screen during long answers.
  const [expanded, setExpanded] = useState(false);

  if (!expanded) {
    // 출처 프로젝트 한 줄 요약 — "공유 RAG 가 답변에 들어갔는지" 한
    // 눈에 확인할 수 있도록 chip 안에 노출.
    const projs = Array.from(
      new Set(chunks.map((c) => c.project_name).filter(Boolean) as string[]),
    );
    return (
      <button
        type="button"
        className="rag-chip rag-chip-used"
        onClick={() => setExpanded(true)}
        title="답변이 참조한 청크 펼치기"
      >
        📚 청크 {chunks.length}개 참조
        {projs.length > 0 && (
          <span className="rag-chip-projs"> · {projs.slice(0, 3).join(", ")}{projs.length > 3 ? " 외" : ""}</span>
        )}
      </button>
    );
  }
  return (
    <div className="rag-box">
      <div className="rag-head">
        <strong>📚 검색된 청크 ({chunks.length})</strong>
        {(() => {
          // 출처 프로젝트별 카운트 — "공유 KB 가 답변에 들어갔는지" 한
          // 줄로 보여주기.
          const byProj: Record<string, { n: number; shared: boolean }> = {};
          for (const c of chunks) {
            const k = c.project_name || "(미상)";
            const cur = byProj[k] ?? { n: 0, shared: false };
            cur.n += 1;
            if (c.project_owned === false) cur.shared = true;
            byProj[k] = cur;
          }
          const parts = Object.entries(byProj).map(([k, v]) => (
            <span key={k} className="rag-source-chip">
              {v.shared && <span className="cowork-shared-badge">공유</span>}
              {k} · {v.n}
            </span>
          ));
          return <span className="rag-sources">{parts}</span>;
        })()}
        <button
          type="button"
          className="rag-collapse"
          onClick={() => setExpanded(false)}
          title="접기"
        >
          접기
        </button>
      </div>
      <ol className="rag-list">
        {chunks.map((c, i) => (
          <li key={i} data-citation-idx={i + 1}>
            <span className="rag-citation-num">[{i + 1}]</span>
            {c.project_name && (
              <span
                className={`rag-proj${c.project_owned === false ? " shared" : ""}`}
                title={
                  c.project_owned === false
                    ? "공유받은 지식베이스"
                    : "내 지식베이스"
                }
              >
                {c.project_owned === false ? "🔗 " : "📁 "}
                {c.project_name}
              </span>
            )}
            <span className="rag-file">{c.filename}</span>
            <span className="rag-range">
              :{c.start_line}-{c.end_line}
            </span>
            <CitationChip score={c.score} />
            {c.project_id && (
              <button
                type="button"
                className="rag-dl-btn"
                title="원본 문서 다운로드 (없으면 청크 텍스트)"
                onClick={async () => {
                  try {
                    await api.downloadChunkSource(
                      c.project_id!,
                      c.filename,
                      c.start_line,
                      c.end_line,
                    );
                  } catch (e) {
                    errorToast("다운로드 실패", e);
                  }
                }}
              >
                💾
              </button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
