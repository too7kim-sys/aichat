/** 빈 채팅 위젯 (#36) — 시간대별 인사말 + 추천 카드 + 별표/매크로
 *  바로 가기. ChatPanel 의 빈 메시지 상태에서 렌더링. */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { BrandLogo } from "../BrandLogo";
import {
  IconBookOpen,
  IconCheckCircle,
  IconCode,
  IconFileText,
  IconGlobe,
} from "../Icon";

export function EmptyGreeting({ userName }: { userName: string | null }) {
  // Resolve everything in a single useMemo so the greeting picks one
  // suggestion at mount and doesn't shuffle on re-render.
  const { headline, sub, suggestions } = useMemo(() => {
    const h = new Date().getHours();
    const timeGreeting =
      h < 5 ? "늦은 밤이네요" :
      h < 12 ? "좋은 아침이에요" :
      h < 18 ? "좋은 오후예요" :
      "좋은 저녁이에요";
    const first = (userName || "").split(/[\s@]/)[0];
    const headline = first
      ? `${timeGreeting}, ${first}님`
      : `${timeGreeting}`;
    const sub = "오늘은 무엇을 도와드릴까요?";
    const suggestions = [
      { Icon: IconFileText, text: "긴 문서를 요약하기" },
      { Icon: IconCheckCircle, text: "오타·맞춤법 검사" },
      { Icon: IconGlobe, text: "웹 검색으로 최신 정보 찾기" },
      { Icon: IconCode, text: "코드 작성 / 리뷰" },
      { Icon: IconBookOpen, text: "번역하기" },
    ];
    return { headline, sub, suggestions };
  }, [userName]);

  // 빈 채팅 환영 위젯 (#36) — 최근 별표 + 자주 쓴 매크로 카드.
  // 둘 다 비어 있어도 기본 suggestions 가 채워 빈 화면처럼 보이지 않게.
  const [starred, setStarred] = useState<
    { id: string; content: string; session_id: string }[]
  >([]);
  const [macros, setMacros] = useState<{ id: string; name: string; body: string }[]>([]);
  useEffect(() => {
    api
      .listStarredMessages?.()
      .then((rows) =>
        setStarred(
          rows.slice(0, 5).map((r) => ({
            id: r.id,
            content: r.content,
            session_id: r.session_id ?? "",
          })),
        ),
      )
      .catch(() => setStarred([]));
    api.listMacros?.()
      .then((rows) => setMacros(rows.slice(0, 5)))
      .catch(() => setMacros([]));
  }, []);

  return (
    <div className="empty-greeting">
      <div className="empty-greeting-logo" aria-hidden="true">
        <BrandLogo size={64} />
      </div>
      <div className="empty-greeting-headline">{headline}</div>
      <div className="empty-greeting-sub">{sub}</div>
      <ul className="empty-greeting-suggestions">
        {suggestions.map((s) => (
          <li key={s.text}>
            <span className="empty-greeting-emoji">
              <s.Icon size={16} />
            </span>
            <span>{s.text}</span>
          </li>
        ))}
      </ul>
      {(starred.length > 0 || macros.length > 0) && (
        <div className="empty-greeting-cards">
          {macros.length > 0 && (
            <div className="empty-greeting-card">
              <div className="empty-greeting-card-head">⌨ 내 매크로</div>
              <ul>
                {macros.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() =>
                        window.dispatchEvent(
                          new CustomEvent("chat:quote-pick", {
                            detail: { text: m.body },
                          }),
                        )
                      }
                      title={m.body.slice(0, 200)}
                    >
                      <code>/{m.name}</code>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {starred.length > 0 && (
            <div className="empty-greeting-card">
              <div className="empty-greeting-card-head">⭐ 최근 별표한 답변</div>
              <ul>
                {starred.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() =>
                        window.dispatchEvent(
                          new CustomEvent("chat:switch-session", {
                            detail: { sessionId: s.session_id, messageId: s.id },
                          }),
                        )
                      }
                      title={s.content.slice(0, 240)}
                    >
                      {s.content.slice(0, 60)}
                      {s.content.length > 60 ? "…" : ""}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
