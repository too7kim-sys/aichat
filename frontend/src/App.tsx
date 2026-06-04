import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api, auth as authApi } from "./api/client";
import { ChatPanel, type ChatPanelHandle } from "./components/ChatPanel";
import { Sidebar } from "./components/Sidebar";
import { ArtifactProvider, useArtifacts } from "./artifact/ArtifactContext";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { AuthForm } from "./auth/AuthForm";
import { ForgotPasswordForm } from "./auth/ForgotPasswordForm";
import { MyPage } from "./auth/MyPage";
import { ResetPasswordForm } from "./auth/ResetPasswordForm";
import { UserMenu } from "./auth/UserMenu";
import { VerifyBanner } from "./auth/VerifyBanner";
import { ModelProvider } from "./state/ModelContext";
import { ProjectsProvider } from "./state/ProjectsContext";
import type { ProviderInfo, Session } from "./types";

// Monaco editor is ~400 kB minified. Split it off the main bundle so the
// chat UI loads instantly; the panel chunk fetches on first use.
const ArtifactPanel = lazy(() =>
  import("./artifact/ArtifactPanel").then((m) => ({ default: m.ArtifactPanel }))
);

export default function App() {
  return (
    <AuthProvider>
      <ModelProvider>
        <ProjectsProvider>
          <ArtifactProvider>
            <AuthGate />
          </ArtifactProvider>
        </ProjectsProvider>
      </ModelProvider>
    </AuthProvider>
  );
}

function AuthGate() {
  const { user, loading, refresh } = useAuth();
  const [view, setView] = useState<"chat" | "mypage">("chat");
  const [authView, setAuthView] = useState<"login" | "forgot">("login");
  const [urlState, setUrlState] = useState<{
    kind: "reset" | "verify-pending" | "verify-done" | "verify-error" | null;
    token?: string;
    message?: string;
  }>({ kind: null });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reset = params.get("reset");
    const verify = params.get("verify");
    if (reset) {
      setUrlState({ kind: "reset", token: reset });
      return;
    }
    if (verify) {
      setUrlState({ kind: "verify-pending" });
      authApi
        .verifyEmail(verify)
        .then(async () => {
          window.history.replaceState({}, "", "/");
          await refresh();
          setUrlState({
            kind: "verify-done",
            message: "이메일이 인증되었습니다.",
          });
        })
        .catch((e) => {
          setUrlState({
            kind: "verify-error",
            message:
              e instanceof Error ? e.message.replace(/^\d+\s/, "") : "오류",
          });
        });
    }
  }, [refresh]);

  if (urlState.kind === "reset" && urlState.token) {
    return (
      <ResetPasswordForm
        token={urlState.token}
        onDone={() => setUrlState({ kind: null })}
      />
    );
  }
  if (urlState.kind === "verify-pending") {
    return <div className="app-loading">이메일 인증 중...</div>;
  }
  if (urlState.kind === "verify-error") {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1 className="auth-brand">Chat</h1>
          <h2 className="auth-title">인증 실패</h2>
          <p className="auth-note">{urlState.message}</p>
          <button
            type="button"
            className="auth-submit"
            onClick={() => {
              window.history.replaceState({}, "", "/");
              setUrlState({ kind: null });
            }}
          >
            계속
          </button>
        </div>
      </div>
    );
  }

  if (loading) return <div className="app-loading">불러오는 중...</div>;
  if (!user) {
    if (authView === "forgot") {
      return <ForgotPasswordForm onBack={() => setAuthView("login")} />;
    }
    return <AuthForm onForgot={() => setAuthView("forgot")} />;
  }
  if (view === "mypage") return <MyPage onBack={() => setView("chat")} />;
  return (
    <AppInner
      onOpenMyPage={() => setView("mypage")}
      verifyFlash={
        urlState.kind === "verify-done" ? urlState.message ?? "" : null
      }
      onDismissFlash={() => setUrlState({ kind: null })}
    />
  );
}

function AppInner({
  onOpenMyPage,
  verifyFlash,
  onDismissFlash,
}: {
  onOpenMyPage: () => void;
  verifyFlash: string | null;
  onDismissFlash: () => void;
}) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const chatRef = useRef<ChatPanelHandle | null>(null);
  const artifacts = useArtifacts();

  async function refreshSessions() {
    const list = await api.listSessions();
    setSessions(list);
    return list;
  }

  useEffect(() => {
    api.listProviders().then(setProviders);
    refreshSessions();
  }, []);

  // Wipe artifact panel state whenever the user switches sessions so old
  // code tabs don't bleed into a new conversation.
  useEffect(() => {
    artifacts.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  async function handleCreate() {
    try {
      const s = await api.createSession("New chat");
      await refreshSessions();
      setActiveId(s.id);
    } catch (e) {
      alert(
        `세션 생성 실패: ${e instanceof Error ? e.message : String(e)}\n\n` +
          `백엔드(http://localhost:9000)가 실행 중인지 확인하세요.`
      );
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
        <div className="app-header-strip">
          <VerifyBanner />
          {verifyFlash && (
            <div className="verify-flash">
              {verifyFlash}
              <button onClick={onDismissFlash}>닫기</button>
            </div>
          )}
          <UserMenu onOpenMyPage={onOpenMyPage} />
        </div>
        {activeId ? (
          <ChatPanel
            key={activeId}
            ref={chatRef}
            sessionId={activeId}
            providers={providers}
            onTitleSync={refreshSessions}
          />
        ) : (
          <div className="empty">왼쪽에서 새 대화를 시작하세요.</div>
        )}
      </main>
      <Suspense fallback={null}>
        <ArtifactPanel
          onSendToChat={(snippet) => chatRef.current?.appendToPrompt(snippet)}
        />
      </Suspense>
    </div>
  );
}
