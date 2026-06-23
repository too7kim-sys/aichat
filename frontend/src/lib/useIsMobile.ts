/** 뷰포트가 모바일 폭(<=720px) 인지를 반응형으로 알려주는 훅.
 *  관리자 페이지 + 채팅 헤더처럼 데스크탑 / 모바일 UX 가 갈리는
 *  곳에서 공유한다.  matchMedia 변경에 즉시 반응하므로 회전 / DevTools
 *  resize 도 그대로 따라옴.  SSR 안전 (window 없으면 false). */
import { useEffect, useState } from "react";

export function useIsMobile(maxWidth = 720): boolean {
  const [mobile, setMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(`(max-width: ${maxWidth}px)`).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [maxWidth]);
  return mobile;
}
