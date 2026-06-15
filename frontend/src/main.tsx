import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "highlight.js/styles/github.css";
import "./styles/app.css";

// 테마 적용 (#35) — 첫 페인트 *전* 에 적용해야 light → dark 깜빡임이
// 없음. localStorage 에 light/dark/system 중 하나, 없으면 system.
(() => {
  const t = localStorage.getItem("chat:theme");
  const theme = t === "light" || t === "dark" || t === "system" ? t : "system";
  document.documentElement.setAttribute("data-theme", theme);
})();

// PWA 서비스 워커 등록 (#51) — 정적 자원 cache-first.  HTTPS / localhost
// 만 지원하므로 보안 컨텍스트 아니면 자동 skip.
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* 등록 실패해도 앱 자체는 정상 — 단순 캐시 손실. */
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
