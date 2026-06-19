/** 웹 검색 출처 박스 — 답변에 인용된 웹 검색 결과를 카테고리별(쇼핑/
 *  뉴스/블로그/위키/웹) 로 묶어 보여 줌. 기본 접힘, 클릭 시 펼침. */
import { useState } from "react";
import type { SearchSource } from "../../api/client";
import { IconPaperclip } from "../Icon";

export function SourcesBox({
  sources,
  warning,
  streaming: _streaming,
}: {
  sources: SearchSource[];
  warning?: string | null;
  // 기본은 항상 접힘 — 검색 출처가 답변 끝을 잡아먹지 않게. 스트리밍
  // 중에도 접힌 칩 형태만 보이고, 사용자가 클릭해야 펼쳐진다.
  streaming?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (sources.length === 0) {
    return (
      <div className="sources">
        <strong>검색 출처</strong>
        <span className="sources-status"> · 검색 중…</span>
        {warning && <div className="sources-warning">{warning}</div>}
      </div>
    );
  }
  if (!expanded) {
    return (
      <button
        type="button"
        className="sources-chip"
        onClick={() => setExpanded(true)}
        title="검색 출처 펼치기"
      >
        <IconPaperclip size={12} /> 출처 {sources.length}개
        {warning ? " · ⚠" : ""}
      </button>
    );
  }
  const shop = sources.filter((s) => s.kind === "shop");
  const news = sources.filter((s) => s.kind === "news");
  const blog = sources.filter((s) => s.kind === "blog" || s.kind === "cafe");
  const wiki = sources.filter((s) => s.kind === "wiki");
  const web = sources.filter((s) => !s.kind || s.kind === "web");

  function srcBadge(s: { source?: string | null }) {
    const src = (s.source || "").toLowerCase();
    if (!src) return null;
    const label = src.startsWith("wikipedia")
      ? "위키"
      : src === "naver"
      ? "N"
      : src === "kakao"
      ? "K"
      : src === "duckduckgo"
      ? "DDG"
      : src;
    return <span className={`src-badge src-${src.split("-")[0]}`}>{label}</span>;
  }
  return (
    <div className="sources">
      <div className="sources-head">
        <strong>검색 출처</strong>
        <button
          type="button"
          className="sources-collapse"
          onClick={() => setExpanded(false)}
          title="접기"
        >
          접기
        </button>
      </div>
      {warning && <div className="sources-warning">⚠ {warning}</div>}
      {shop.length > 0 && (
        <>
          <div className="sources-section">쇼핑</div>
          <div className="shop-grid">
            {shop.map((s, i) => (
              <a
                key={`shop-${i}`}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="shop-card"
                title={s.title}
              >
                {s.image ? (
                  <img src={s.image} alt="" loading="lazy" />
                ) : (
                  <div className="shop-card-noimage">이미지 없음</div>
                )}
                <div className="shop-card-body">
                  <div className="shop-card-title">{s.title}</div>
                  {s.lprice != null && (
                    <div className="shop-card-price">
                      {s.lprice.toLocaleString("ko-KR")}원
                    </div>
                  )}
                  {s.mall && <div className="shop-card-mall">{s.mall}</div>}
                </div>
              </a>
            ))}
          </div>
        </>
      )}
      {news.length > 0 && (
        <>
          <div className="sources-section">뉴스</div>
          <ol className="sources-list">
            {news.map((s, i) => (
              <li key={`news-${i}`}>
                {srcBadge(s)}
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ol>
        </>
      )}
      {blog.length > 0 && (
        <>
          <div className="sources-section">블로그/카페</div>
          <ol className="sources-list">
            {blog.map((s, i) => (
              <li key={`blog-${i}`}>
                {srcBadge(s)}
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ol>
        </>
      )}
      {wiki.length > 0 && (
        <>
          <div className="sources-section">위키</div>
          <ol className="sources-list">
            {wiki.map((s, i) => (
              <li key={`wiki-${i}`}>
                {srcBadge(s)}
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ol>
        </>
      )}
      {web.length > 0 && (
        <>
          <div className="sources-section">웹</div>
          <ol className="sources-list">
            {web.map((s, i) => (
              <li key={`web-${i}`}>
                {srcBadge(s)}
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
