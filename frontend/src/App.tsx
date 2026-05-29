import { useEffect, useState } from "react";
import { api } from "./api/client";
import { ChatPanel } from "./components/ChatPanel";
import { Sidebar } from "./components/Sidebar";
import type { Mode, ProviderInfo, Session } from "./types";

export default function App() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  async function refreshSessions() {
    const list = await api.listSessions();
    setSessions(list);
    return list;
  }

  useEffect(() => {
    api.listProviders().then(setProviders);
    refreshSessions();
  }, []);

  async function handleCreate(mode: Mode) {
    try {
      const s = await api.createSession("New chat", mode);
      await refreshSessions();
      setActiveId(s.id);
    } catch (e) {
      alert(`세션 생성 실패: ${e instanceof Error ? e.message : String(e)}\n\n백엔드(http://localhost:9000)가 실행 중인지 확인하세요.`);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteSession(id);
      const list = await refreshSessions();
      if (activeId === id) setActiveId(list[0]?.id ?? null);
    } catch (e) {
      alert(`세션 삭제 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={handleCreate}
        onDelete={handleDelete}
      />
      <main className="main">
        {activeId ? (
          <ChatPanel
            key={activeId}
            sessionId={activeId}
            providers={providers}
            onTitleSync={refreshSessions}
          />
        ) : (
          <div className="empty">
            왼쪽에서 새 대화를 시작하세요.
          </div>
        )}
      </main>
    </div>
  );
}
