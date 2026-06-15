import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";

type Sort = "sim" | "date" | "asc" | "dsc";

interface Product {
  title: string;
  link: string;
  image: string;
  lprice: number | null;
  hprice: number | null;
  mall: string;
  brand: string;
  category: string;
  productId: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 사용자가 상품 카드의 'AI 에 물어보기' 를 눌렀을 때 호출. 부모가
   *  composer 에 prefill 하거나 즉시 send 를 결정. */
  onSendToChat: (text: string) => void;
}

const SORT_OPTIONS: { value: Sort; label: string }[] = [
  { value: "sim", label: "정확도순" },
  { value: "date", label: "최신순" },
  { value: "asc", label: "낮은가격" },
  { value: "dsc", label: "높은가격" },
];

// 한국 대표 쇼핑몰 — Naver shop 의 mallName 부분일치 필터로 좁힌다.
const MALL_PRESETS = [
  "전체",
  "쿠팡",
  "11번가",
  "G마켓",
  "옥션",
  "위메프",
  "티몬",
  "롯데ON",
  "SSG",
  "네이버",
];

export function ShoppingBrowser({ open, onClose, onSendToChat }: Props) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("sim");
  const [mall, setMall] = useState<string>("전체");
  const [items, setItems] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      // 모달 열릴 때 검색창에 자동 포커스 — 키보드만으로도 바로 검색.
      window.setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      // 닫힐 때 선택 상태는 초기화 — 다음 번 열 때 깨끗하게.
      setPicked(new Set());
    }
  }, [open]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && open) {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function runSearch() {
    if (!query.trim()) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await api.searchShop(query.trim(), {
        sort,
        display: 40,
        mall: mall === "전체" ? "" : mall,
      });
      setItems(res.items);
      if (res.items.length === 0) setErr("결과가 없어요. 키워드나 몰을 바꿔 보세요.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  function togglePick(id: string) {
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function sendSelected() {
    // 선택한 카드들로 비교/조언 요청 프롬프트 자동 생성. 가격/몰 정보
    // 까지 LLM 에 그대로 넘기면 추천 근거가 풍부해진다.
    const chosen = items.filter((p) => picked.has(p.productId || p.link));
    const list = chosen.length > 0 ? chosen : items.slice(0, 5);
    if (list.length === 0) return;
    const lines = list.map((p, i) => {
      const price =
        p.lprice != null ? `${p.lprice.toLocaleString("ko-KR")}원` : "가격정보 없음";
      return `${i + 1}. ${p.title}\n   - 가격: ${price}\n   - 판매처: ${p.mall || "?"}${
        p.brand ? ` · 브랜드: ${p.brand}` : ""
      }\n   - 링크: ${p.link}`;
    });
    const intro =
      chosen.length > 0
        ? `아래 ${chosen.length}개 상품 중에서 어떤 걸 사는 게 좋을지 비교해 주세요.`
        : `'${query}' 로 검색한 상품 ${list.length}개입니다. 가격·평판·실사용 후기 관점에서 추천을 해 주세요.`;
    const text = `${intro}\n\n${lines.join("\n\n")}\n\n(검색어: ${query}, 정렬: ${
      SORT_OPTIONS.find((o) => o.value === sort)?.label ?? sort
    }${mall !== "전체" ? `, 몰: ${mall}` : ""})`;
    onSendToChat(text);
    onClose();
  }

  if (!open) return null;
  return (
    <div className="shop-browser-backdrop" onClick={onClose}>
      <div
        className="shop-browser"
        role="dialog"
        aria-label="쇼핑 검색"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shop-browser-head">
          <h3>🛒 쇼핑 검색</h3>
          <button type="button" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        <div className="shop-browser-controls">
          <input
            ref={inputRef}
            className="shop-browser-input"
            placeholder="예) 무선 마우스, 한국산 보쌈김치, 27인치 모니터"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runSearch();
              }
            }}
          />
          <button
            type="button"
            className="shop-browser-search"
            onClick={runSearch}
            disabled={!query.trim() || loading}
          >
            {loading ? "검색 중…" : "검색"}
          </button>
        </div>
        <div className="shop-browser-filters">
          <span className="shop-browser-filter-label">정렬</span>
          {SORT_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`shop-browser-chip${sort === o.value ? " picked" : ""}`}
              onClick={() => setSort(o.value)}
            >
              {o.label}
            </button>
          ))}
          <span className="shop-browser-filter-label">몰</span>
          {MALL_PRESETS.map((m) => (
            <button
              key={m}
              type="button"
              className={`shop-browser-chip${mall === m ? " picked" : ""}`}
              onClick={() => setMall(m)}
            >
              {m}
            </button>
          ))}
        </div>
        {err && <div className="shop-browser-error">⚠ {err}</div>}
        <div className="shop-browser-grid">
          {items.map((p) => {
            const id = p.productId || p.link;
            const isPicked = picked.has(id);
            return (
              <div
                key={id}
                className={`shop-browser-card${isPicked ? " picked" : ""}`}
              >
                <button
                  type="button"
                  className="shop-browser-card-pick"
                  onClick={() => togglePick(id)}
                  title={isPicked ? "선택 해제" : "선택"}
                  aria-pressed={isPicked}
                >
                  {isPicked ? "✓" : "+"}
                </button>
                <a
                  className="shop-browser-card-link"
                  href={p.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={p.title}
                >
                  {p.image ? (
                    <img src={p.image} alt="" loading="lazy" />
                  ) : (
                    <div className="shop-browser-card-noimg">이미지 없음</div>
                  )}
                  <div className="shop-browser-card-body">
                    <div className="shop-browser-card-title">{p.title}</div>
                    {p.lprice != null && (
                      <div className="shop-browser-card-price">
                        {p.lprice.toLocaleString("ko-KR")}원
                      </div>
                    )}
                    <div className="shop-browser-card-meta">
                      {p.mall || "—"}
                      {p.brand ? ` · ${p.brand}` : ""}
                    </div>
                  </div>
                </a>
              </div>
            );
          })}
        </div>
        {items.length > 0 && (
          <div className="shop-browser-foot">
            <span className="shop-browser-count">
              {picked.size > 0
                ? `${picked.size}개 선택`
                : `${items.length}개 결과`}
            </span>
            <button
              type="button"
              className="shop-browser-send"
              onClick={sendSelected}
              disabled={items.length === 0}
            >
              {picked.size > 0
                ? `선택 ${picked.size}개로 AI 에 비교 요청`
                : "상위 5개로 AI 에 추천 요청"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
