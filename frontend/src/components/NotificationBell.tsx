import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";

/** 🔔 알림 벨 (#94) — 헤더 우상단에 미확인 카운트 + 드롭다운.
 *  60초마다 가벼운 폴링.  추후 SSE / WS 로 교체 가능. */
export function NotificationBell() {
  type Item = {
    id: string;
    kind: string;
    title: string;
    body: string | null;
    link: string | null;
    read_at: string | null;
    created_at: string | null;
  };
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  async function refresh() {
    try {
      const r = await api.listNotifications(false, 50);
      setItems(r.items);
      setUnread(r.unread_count);
    } catch {
      /* 미인증 / 네트워크 등 — 조용히 무시. */
    }
  }
  useEffect(() => {
    void refresh();
    const t = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function clickItem(it: Item) {
    if (!it.read_at) {
      try {
        await api.markNotificationRead(it.id);
      } catch {
        /* ignore */
      }
    }
    // 백엔드가 link 에 cowork=actions / workflows / approvals 같은 쿼리
    // 를 박아 보내면 해당 패널을 띄운다.  단순 history pushState 만
    // 해서는 React 가 반응하지 않으므로 커스텀 이벤트로 우회.
    if (it.link) {
      try {
        const u = new URL(it.link, window.location.origin);
        const cw = u.searchParams.get("cowork");
        const adminTab = u.searchParams.get("admin");
        let handled = false;
        if (cw === "actions") {
          window.dispatchEvent(new CustomEvent("cowork:open-actions"));
          handled = true;
        } else if (cw === "workflows" || cw === "approvals") {
          window.dispatchEvent(new CustomEvent("cowork:open-approvals"));
          handled = true;
        } else if (cw === "teams") {
          window.dispatchEvent(new CustomEvent("cowork:open-teams"));
          handled = true;
        }
        if (adminTab) {
          // 관리자 페이지 진입 + 탭 힌트.  AdminPage 가 location 의
          // ?admin= 을 읽어 해당 view 로 시작.
          window.dispatchEvent(new CustomEvent("nav:admin-tab", {
            detail: { tab: adminTab },
          }));
          handled = true;
        }
        const target = u.searchParams.get("target");
        if (target?.startsWith("session:")) {
          window.dispatchEvent(
            new CustomEvent("chat:switch-session", {
              detail: { sessionId: target.slice("session:".length) },
            }),
          );
          handled = true;
        }
        // 일치하는 핸들러가 없으면 그냥 navigate — 외부 링크 / 새 escape
        // hatch.  link 가 우리 origin 안이면 SPA 점프, 밖이면 새 탭.
        if (!handled) {
          if (u.origin === window.location.origin) {
            window.location.href = it.link;
          } else {
            window.open(it.link, "_blank", "noopener");
          }
        }
      } catch {
        /* 잘못된 link — 무시 */
      }
    }
    setOpen(false);
    void refresh();
  }
  async function markAll() {
    try {
      await api.markAllNotificationsRead();
    } catch {
      /* ignore */
    }
    void refresh();
  }

  return (
    <div className="notif-wrap" ref={ref}>
      <button
        type="button"
        className="notif-trigger"
        onClick={() => setOpen((v) => !v)}
        title="알림"
        aria-label="알림"
      >
        🔔
        {unread > 0 && (
          <span className="notif-badge">{unread > 99 ? "99+" : unread}</span>
        )}
      </button>
      {open && (
        <div className="notif-pop" role="dialog" aria-label="알림">
          <div className="notif-head">
            <strong>알림</strong>
            <button type="button" onClick={markAll}>
              모두 읽음
            </button>
          </div>
          {items.length === 0 ? (
            <div className="notif-empty">📭 새 알림이 없어요</div>
          ) : (
            <ul className="notif-list">
              {items.map((it) => (
                <li
                  key={it.id}
                  className={it.read_at ? "" : "unread"}
                  onClick={() => clickItem(it)}
                >
                  <div className="notif-title">{it.title}</div>
                  {it.body && <div className="notif-body">{it.body}</div>}
                  <div className="notif-time">
                    {it.created_at
                      ? new Date(it.created_at).toLocaleString()
                      : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
