import { useEffect, useState } from "react";
import { api } from "./api/client";
import { BrandLogo } from "./components/BrandLogo";
import type { SessionDetail } from "./types";

/** /share/<token> 으로 진입했을 때 보여줄 읽기 전용 뷰 (#38).
 *  로그인이 풀린 상태면 일반 AuthGate 가 먼저 잡아 토큰을 들고 다시
 *  돌아옴 (현재 URL 이 보존되므로).  공유는 폐쇄망 원칙상 로그인된
 *  사용자에게만 노출 — anon 접근은 백엔드에서 차단. */
export function SharedSessionView({
  token,
  onExit,
}: {
  token: string;
  onExit: () => void;
}) {
  const [data, setData] = useState<SessionDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.getSharedSession(token);
        if (!cancelled) {
          setData(r);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="shared-view">
      <header className="shared-view-header">
        <button
          type="button"
          className="shared-view-back"
          onClick={onExit}
        >
          ← 내 대화로
        </button>
        <span className="shared-view-brand">
          <BrandLogo size={20} /> 공유받은 대화
        </span>
      </header>
      <main className="shared-view-main">
        {loading ? (
          <div className="shared-view-empty">불러오는 중…</div>
        ) : err ? (
          <div className="shared-view-empty shared-view-error">⚠ {err}</div>
        ) : !data ? null : (
          <>
            <h2 className="shared-view-title">{data.title}</h2>
            <div className="shared-view-readonly">
              읽기 전용 — 이 대화를 보고 있는 다른 사용자에게는 편집·답변이
              비공개입니다.
            </div>
            <ul className="shared-view-messages">
              {data.messages.map((m) => (
                <li
                  key={m.id}
                  className={`shared-view-msg shared-view-msg-${m.role}`}
                >
                  <div className="shared-view-msg-head">
                    {m.role === "user" ? "사용자" : m.provider || "AI"}
                    {" · "}
                    {new Date(m.created_at).toLocaleString()}
                  </div>
                  <div className="shared-view-msg-body">{m.content}</div>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}
