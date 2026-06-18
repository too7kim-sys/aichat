import { useEffect, useRef, useState } from "react";
import { IconUsers } from "../components/Icon";
import { useAuth } from "./AuthContext";
import { TeamsPanel } from "../components/CoworkPanels";

interface Props {
  onOpenMyPage: () => void;
  onOpenAdmin?: () => void;
}

export function UserMenu({ onOpenMyPage, onOpenAdmin }: Props) {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [teamsOpen, setTeamsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 테마 (#35) — light / dark / system.  main.tsx 가 첫 페인트 전에
  // data-theme 을 박아 두고, 여기서는 토글만.
  const [theme, _setTheme] = useState<"light" | "dark" | "system">(() => {
    const t = localStorage.getItem("chat:theme");
    return t === "light" || t === "dark" || t === "system" ? t : "system";
  });
  function setTheme(v: "light" | "dark" | "system") {
    _setTheme(v);
    localStorage.setItem("chat:theme", v);
    document.documentElement.setAttribute("data-theme", v);
  }
  // PII 마스킹 (#43) — 켜면 BubbleContent 가 display-time 에 본문의
  // 개인정보를 가림.  서버 저장은 원본 유지.
  const [piiMask, _setPiiMask] = useState<boolean>(
    () => localStorage.getItem("chat:pii-mask") === "1",
  );
  function togglePii() {
    const next = !piiMask;
    _setPiiMask(next);
    if (next) localStorage.setItem("chat:pii-mask", "1");
    else localStorage.removeItem("chat:pii-mask");
    // 강제 새로고침으로 모든 버블 다시 그림 — 너무 무거우면 이벤트
    // 디스패치로 대체할 수 있지만, 토글은 자주 일어나지 않으니 그대로.
    window.location.reload();
  }

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  if (!user) return null;
  const initial =
    (user.name?.[0] || user.email[0] || "?").toUpperCase();

  return (
    <div className="user-menu" ref={ref}>
      <button
        className="user-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        title={user.email}
      >
        <span className="user-menu-avatar">{initial}</span>
      </button>
      {open && (
        <div className="user-menu-pop">
          <div className="user-menu-info">
            <div className="user-menu-name">{user.name || user.email}</div>
            {user.name && <div className="user-menu-email">{user.email}</div>}
          </div>
          <button
            className="user-menu-item"
            onClick={() => {
              setOpen(false);
              setTeamsOpen(true);
            }}
          >
            👥 팀 관리
          </button>
          <button
            className="user-menu-item"
            onClick={() => {
              setOpen(false);
              onOpenMyPage();
            }}
          >
            마이페이지
          </button>
          <div className="user-menu-theme">
            <div className="user-menu-theme-label">테마</div>
            <div className="user-menu-theme-chips">
              {(["light", "dark", "system"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`user-menu-theme-chip${theme === t ? " picked" : ""}`}
                  onClick={() => setTheme(t)}
                >
                  {t === "light" ? "☀ 라이트" : t === "dark" ? "🌙 다크" : "💻 시스템"}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            className={`user-menu-item${piiMask ? " active" : ""}`}
            onClick={togglePii}
            title="전화번호·주민번호·이메일·카드번호 후보를 가림"
          >
            🔒 개인정보 마스킹 {piiMask ? "ON" : "OFF"}
          </button>
          {onOpenAdmin && (user.role === "admin" || user.role === "moderator") && (
            <button
              className="user-menu-item"
              onClick={() => {
                setOpen(false);
                onOpenAdmin();
              }}
            >
              <IconUsers size={14} />
              <span>권한 관리</span>
              {user.role === "admin" && (
                <span className="user-menu-badge">관리자</span>
              )}
            </button>
          )}
          <button
            className="user-menu-item"
            onClick={() => {
              setOpen(false);
              logout();
            }}
          >
            로그아웃
          </button>
        </div>
      )}
      {teamsOpen && <TeamsPanel onClose={() => setTeamsOpen(false)} />}
    </div>
  );
}
