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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
