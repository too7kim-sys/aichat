import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api, auth as authApi } from "./api/client";
import { BrandLogo } from "./components/BrandLogo";
import { ChatPanel, type ChatPanelHandle } from "./components/ChatPanel";
import { SearchBar, type SearchBarHandle } from "./components/SearchBar";
import { Sidebar, type Workspace } from "./components/Sidebar";
import { CmdPalette } from "./components/CmdPalette";
import { ArtifactProvider, useArtifacts } from "./artifact/ArtifactContext";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { AuthForm } from "./auth/AuthForm";
import { ForgotPasswordForm } from "./auth/ForgotPasswordForm";
import { AdminPage } from "./admin/AdminPage";
import { MyPage } from "./auth/MyPage";
import { SharedSessionView } from "./SharedSessionView";
import { ResetPasswordForm } from "./auth/ResetPasswordForm";
import { UserMenu } from "./auth/UserMenu";
import { VerifyBanner } from "./auth/VerifyBanner";
import { ModelProvider } from "./state/ModelContext";
import { ProjectsProvider } from "./state/ProjectsContext";
import { WorkspacesProvider } from "./state/WorkspacesContext";
import type { ChatProject, ProviderInfo, Session } from "./types";

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
          <WorkspacesProvider>
            <ArtifactProvider>
              <AuthGate />
            </ArtifactProvider>
          </WorkspacesProvider>
        </ProjectsProvider>
      </ModelProvider>
    </AuthProvider>
  );
}

function AuthGate() {
  const { user, loading, refresh } = useAuth();
  const [view, setView] = useState<"chat" | "mypage" | "admin">("chat");
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
          <h1 className="auth-brand">
            <BrandLogo size={32} aria-label="Chat 로고" />
            <span>Chat</span>
          </h1>
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
  if (view === "admin")
    return <AdminPage onBack={() => setView("chat")} />;
  // 공유 링크 진입 (#38) — /share/<token> URL 이면 SharedSessionView 로.
  const sharePath = window.location.pathname.match(/^\/share\/([\w-]+)/);
  if (sharePath) {
    return (
      <SharedSessionView
        token={sharePath[1]}
        onExit={() => {
          window.history.replaceState({}, "", "/");
          setView("chat");
        }}
      />
    );
  }
  return (
    <AppInner
      onOpenMyPage={() => setView("mypage")}
      onOpenAdmin={() => setView("admin")}
      verifyFlash={
        urlState.kind === "verify-done" ? urlState.message ?? "" : null
      }
      onDismissFlash={() => setUrlState({ kind: null })}
    />
  );
}

function AppInner({
  onOpenMyPage,
  onOpenAdmin,
  verifyFlash,
  onDismissFlash,
}: {
  onOpenMyPage: () => void;
  onOpenAdmin: () => void;
  verifyFlash: string | null;
  onDismissFlash: () => void;
}) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [chatProjects, setChatProjects] = useState<ChatProject[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Pending scroll target — set by the global SearchBar when the
  // user picks a result so ChatPanel knows which message to flash
  // into view after the (potentially cross-session) navigation.
  // Cleared by ChatPanel once handled.
  const [pendingScrollMessageId, setPendingScrollMessageId] = useState<
    string | null
  >(null);
  const chatRef = useRef<ChatPanelHandle | null>(null);
  const searchRef = useRef<SearchBarHandle | null>(null);
  const artifacts = useArtifacts();

  // 단축키 도움말 모달 (#19) — ? 키로 토글. 입력칸 포커스 중이면
  // 평범한 텍스트 입력이라 무시.
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  // Cmd 팔레트 (#49) — Ctrl/⌘+Shift+P 로 띄움.
  const [cmdPalOpen, setCmdPalOpen] = useState(false);

  // Global keyboard shortcut: ⌘K / Ctrl+K focuses the header search
  // input from anywhere on the page. The input lives in the header
  // strip and is always visible, so this just yanks focus to it
  // rather than opening any modal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmdK =
        (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
      if (isCmdK) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      // Cmd 팔레트 — Ctrl/⌘+Shift+P (#49).
      const isCmdShiftP =
        (e.key === "p" || e.key === "P") &&
        e.shiftKey &&
        (e.metaKey || e.ctrlKey);
      if (isCmdShiftP) {
        e.preventDefault();
        setCmdPalOpen((v) => !v);
        return;
      }
      // ? 단축키 — 도움말 모달 토글.  입력칸 포커스 중이면 패스.
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
        const inField =
          tag === "input" || tag === "textarea" || tag === "select" ||
          (e.target as HTMLElement | null)?.isContentEditable;
        if (inField) return;
        e.preventDefault();
        setShortcutHelpOpen((v) => !v);
      } else if (e.key === "Escape" && shortcutHelpOpen) {
        setShortcutHelpOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcutHelpOpen]);

  function jumpToMessage(sessionId: string, messageId: string | null) {
    if (messageId) setPendingScrollMessageId(messageId);
    if (sessionId !== activeId) setActiveId(sessionId);
  }

  function closeActiveChat() {
    setActiveId(null);
  }

  // Top-level workspace tab — Chat / Code. Persisted across reloads so
  // the user lands back where they left off. (Legacy "cowork" value
  // from before RAG moved to the admin panel falls back to chat.)
  const [workspace, _setWorkspace] = useState<Workspace>(() => {
    const stored = localStorage.getItem("chat:workspace");
    if (stored === "chat" || stored === "code") return stored;
    return "chat";
  });
  function setWorkspace(w: Workspace) {
    _setWorkspace(w);
    localStorage.setItem("chat:workspace", w);
  }

  async function refreshSessions() {
    const list = await api.listSessions();
    setSessions(list);
    return list;
  }

  async function refreshChatProjects() {
    try {
      setChatProjects(await api.listChatProjects());
    } catch {
      // Endpoint may be unavailable on a stale backend — fail soft so
      // the sidebar still renders the date groups.
    }
  }

  useEffect(() => {
    api.listProviders().then(setProviders);
    refreshSessions();
    refreshChatProjects();
    // 메시지 공유 링크 처리 — ?session=...&message=... 가 있으면 그
    // 세션으로 열고 해당 메시지로 스크롤.
    const u = new URL(window.location.href);
    const sid = u.searchParams.get("session");
    const mid = u.searchParams.get("message");
    if (sid) {
      setActiveId(sid);
      if (mid) setPendingScrollMessageId(mid);
      // 깔끔하게 URL 정리 — 새로고침해도 그대로 유지하고 싶으면 이 줄을 빼면 됨.
      u.searchParams.delete("session");
      u.searchParams.delete("message");
      window.history.replaceState({}, "", u.toString());
    }
  }, []);

  // 메시지 분기 (🌿) 가 새 세션을 만들고 chat:switch-session 이벤트
  // 를 띄우면, 사이드바 목록 갱신 + activeId 전환.
  useEffect(() => {
    function onSwitch(e: Event) {
      const ev = e as CustomEvent<{ sessionId: string; messageId?: string }>;
      const sid = ev.detail?.sessionId;
      const mid = ev.detail?.messageId;
      if (!sid) return;
      void (async () => {
        await refreshSessions();
        setActiveId(sid);
        if (mid) setPendingScrollMessageId(mid);
      })();
    }
    window.addEventListener("chat:switch-session", onSwitch);
    return () => window.removeEventListener("chat:switch-session", onSwitch);
  }, []);

  // Wipe artifact panel state whenever the user switches sessions so old
  // code tabs don't bleed into a new conversation.
  useEffect(() => {
    artifacts.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  async function handleCreate(chatProjectId?: string | null) {
    try {
      const s = await api.createSession("New chat", chatProjectId ?? null);
      await Promise.all([refreshSessions(), refreshChatProjects()]);
      setActiveId(s.id);
    } catch (e) {
      alert(
        `세션 생성 실패: ${e instanceof Error ? e.message : String(e)}\n\n` +
          `백엔드(http://localhost:9000)가 실행 중인지 확인하세요.`
      );
    }
  }

  async function handleCreateFromWorkspace(workspaceId: string) {
    try {
      const res = await api.startChatFromWorkspace(workspaceId);
      // No client-side queueing: the session is permanently linked
      // to the workspace, so the chat router auto-injects the files
      // server-side on every turn. The user never re-attaches.
      await refreshSessions();
      setActiveId(res.session_id);
    } catch (e) {
      alert(
        `워크스페이스 채팅 시작 실패: ${
          e instanceof Error ? e.message : String(e)
        }`,
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

  // Mobile sidebar drawer state. On wide screens the sidebar is
  // always visible regardless of this flag; on narrow viewports the
  // CSS @media rule turns it into a slide-in overlay that respects
  // .sidebar.open.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // 가벼운 토스트 — 어디서든 window.dispatchEvent("chat:toast",
  // { detail: { text } }) 만 쏘면 우측 하단에 뜬다. 공유 링크 복사,
  // 자잘한 안내 등에 사용. 2.4 초 후 자동 사라짐.
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    let tid: number | undefined;
    function onToast(e: Event) {
      const ev = e as CustomEvent<{ text: string }>;
      if (!ev.detail?.text) return;
      setToast(ev.detail.text);
      window.clearTimeout(tid);
      tid = window.setTimeout(() => setToast(null), 2400);
    }
    window.addEventListener("chat:toast", onToast);
    return () => {
      window.removeEventListener("chat:toast", onToast);
      window.clearTimeout(tid);
    };
  }, []);

  return (
    <div className="app">
      <Sidebar
        className={sidebarOpen ? "open" : ""}
        workspace={workspace}
        onWorkspaceChange={setWorkspace}
        sessions={sessions}
        activeId={activeId}
        chatProjects={chatProjects}
        onSelect={(id) => {
          setActiveId(id);
          setSidebarOpen(false);
        }}
        onCreate={(chatProjectId) => {
          handleCreate(chatProjectId);
          setSidebarOpen(false);
        }}
        onDelete={handleDelete}
        onStartChatFromWorkspace={handleCreateFromWorkspace}
        onSessionRefresh={async () => {
          await refreshSessions();
        }}
        onChatProjectsRefresh={async () => {
          await Promise.all([refreshChatProjects(), refreshSessions()]);
        }}
      />
      {/* Mobile-only backdrop to dismiss the sidebar drawer. CSS hides
          it above 900px so it has no effect on desktop. */}
      {sidebarOpen && (
        <button
          type="button"
          aria-label="사이드바 닫기"
          className="mobile-drawer-backdrop"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <main className="main">
        <div className="app-header-strip">
          <button
            type="button"
            className="mobile-menu-btn"
            aria-label="메뉴 열기"
            onClick={() => setSidebarOpen(true)}
          >
            ☰
          </button>
          <VerifyBanner />
          {verifyFlash && (
            <div className="verify-flash">
              {verifyFlash}
              <button onClick={onDismissFlash}>닫기</button>
            </div>
          )}
          <SearchBar
            ref={searchRef}
            sessions={sessions}
            onPick={jumpToMessage}
          />
          <UserMenu onOpenMyPage={onOpenMyPage} onOpenAdmin={onOpenAdmin} />
        </div>
        {activeId ? (
          <ChatPanel
            key={activeId}
            ref={chatRef}
            sessionId={activeId}
            providers={providers}
            onTitleSync={refreshSessions}
            scrollToMessageId={pendingScrollMessageId}
            onScrollHandled={() => setPendingScrollMessageId(null)}
            onCloseChat={closeActiveChat}
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
      {toast && (
        <div className="chat-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
      {cmdPalOpen && (
        <CmdPalette
          sessions={sessions}
          onCreateChat={() => handleCreate(null)}
          onClose={() => setCmdPalOpen(false)}
        />
      )}
      {shortcutHelpOpen && (
        <div
          className="shortcut-help-backdrop"
          onClick={() => setShortcutHelpOpen(false)}
        >
          <div
            className="shortcut-help-card"
            role="dialog"
            aria-label="단축키 도움말"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="shortcut-help-head">
              <h3>단축키</h3>
              <button
                type="button"
                onClick={() => setShortcutHelpOpen(false)}
                aria-label="닫기"
              >
                ✕
              </button>
            </div>
            <table className="shortcut-help-table">
              <tbody>
                <tr><td><kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd></td><td>상단 검색</td></tr>
                <tr><td><kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>F</kbd></td><td>이 대화에서 찾기</td></tr>
                <tr><td><kbd>?</kbd></td><td>이 도움말</td></tr>
                <tr><td><kbd>[</kbd> / <kbd>]</kbd></td><td>별표 메시지 사이 이동</td></tr>
                <tr><td><kbd>Enter</kbd></td><td>메시지 전송 (Shift+Enter 줄바꿈)</td></tr>
                <tr><td><kbd>/</kbd></td><td>프롬프트 라이브러리 (입력칸 시작 시)</td></tr>
                <tr><td><kbd>Esc</kbd></td><td>검색·메뉴·이 도움말 닫기</td></tr>
              </tbody>
            </table>
            <div className="shortcut-help-foot">
              한국어 도움말 — 변경 사항이 있으면 단축키가 자동으로 반영됩니다.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
