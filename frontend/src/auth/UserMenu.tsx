import { useEffect, useRef, useState } from "react";
import { IconUsers } from "../components/Icon";
import { useAuth } from "./AuthContext";

interface Props {
  onOpenMyPage: () => void;
  onOpenAdmin?: () => void;
}

export function UserMenu({ onOpenMyPage, onOpenAdmin }: Props) {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
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
    </div>
  );
}
