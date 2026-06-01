import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api } from "./api/client";
import { ChatPanel, type ChatPanelHandle } from "./components/ChatPanel";
import { Sidebar } from "./components/Sidebar";
import { ArtifactProvider, useArtifacts } from "./artifact/ArtifactContext";
import { ProjectProvider, useProject } from "./project/ProjectContext";
import { readPath, writeFile } from "./project/fsAccess";
import { useDiffPreview } from "./project/DiffPreview";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { AuthForm } from "./auth/AuthForm";
import { MyPage } from "./auth/MyPage";
import { UserMenu } from "./auth/UserMenu";
import type { ProviderInfo, Session } from "./types";
import type { ProjectFile } from "./project/fsAccess";

// Monaco editor is ~400 kB minified. Split it off the main bundle so the
// chat UI loads instantly; the panel chunk fetches on first use.
const ArtifactPanel = lazy(() =>
  import("./artifact/ArtifactPanel").then((m) => ({ default: m.ArtifactPanel }))
);

export default function App() {
  return (
    <AuthProvider>
      <ArtifactProvider>
        <ProjectProvider>
          <AuthGate />
        </ProjectProvider>
      </ArtifactProvider>
    </AuthProvider>
  );
}

function AuthGate() {
  const { user, loading } = useAuth();
  const [view, setView] = useState<"chat" | "mypage">("chat");
  if (loading) return <div className="app-loading">불러오는 중...</div>;
  if (!user) return <AuthForm />;
  if (view === "mypage") return <MyPage onBack={() => setView("chat")} />;
  return <AppInner onOpenMyPage={() => setView("mypage")} />;
}

function AppInner({ onOpenMyPage }: { onOpenMyPage: () => void }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const chatRef = useRef<ChatPanelHandle | null>(null);
  const artifacts = useArtifacts();
  const project = useProject();
  const diff = useDiffPreview();

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

  function handleOpenProjectFile(file: ProjectFile, content: string) {
    artifacts.push({
      title: file.path,
      language: guessLangFromPath(file.path),
      code: content,
    });
  }

  function handleAddProjectFileToContext(file: ProjectFile, content: string) {
    if (!chatRef.current) {
      alert("먼저 대화를 선택하거나 새로 만들어주세요.");
      return;
    }
    chatRef.current.addAttachmentFromText(file.path, content);
  }

  async function handleApplyFiles(
    files: { path: string; language: string; content: string }[]
  ) {
    const root = project.root;
    if (!root) {
      alert("먼저 사이드바 '프로젝트' 탭에서 폴더를 선택해주세요.");
      return;
    }
    let applied = 0;
    for (const f of files) {
      const outcome = await diff.open(
        { filename: f.path, proposed: f.content, language: f.language || guessLangFromPath(f.path) },
        () => readPath(root, f.path)
      );
      if (!outcome.confirmed) continue;
      try {
        await writeFile(root, f.path, outcome.content);
        applied += 1;
      } catch (e) {
        alert(`${f.path} 저장 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (applied > 0) project.refresh();
  }

  async function handleSaveArtifactToProject(filename: string, code: string) {
    const root = project.root;
    if (!root) {
      alert("먼저 사이드바 '프로젝트' 탭에서 폴더를 선택해주세요.");
      return;
    }
    const target = window.prompt(
      "저장할 상대 경로를 입력하세요 (예: src/foo.py)",
      filename
    );
    if (!target) return;
    const outcome = await diff.open(
      { filename: target, proposed: code, language: guessLangFromPath(target) },
      () => readPath(root, target)
    );
    if (!outcome.confirmed) return;
    try {
      await writeFile(root, target, outcome.content);
      project.refresh();
    } catch (e) {
      alert(`저장 실패: ${e instanceof Error ? e.message : String(e)}`);
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
        onOpenProjectFile={handleOpenProjectFile}
        onAddProjectFileToContext={handleAddProjectFileToContext}
      />
      <main className="main">
        <div className="app-header-strip">
          <UserMenu onOpenMyPage={onOpenMyPage} />
        </div>
        {activeId ? (
          <ChatPanel
            key={activeId}
            ref={chatRef}
            sessionId={activeId}
            providers={providers}
            onTitleSync={refreshSessions}
            onApplyFiles={handleApplyFiles}
          />
        ) : (
          <div className="empty">왼쪽에서 새 대화를 시작하세요.</div>
        )}
      </main>
      <Suspense fallback={null}>
        <ArtifactPanel
          onSendToChat={(snippet) => chatRef.current?.appendToPrompt(snippet)}
          onSaveToProject={handleSaveArtifactToProject}
          projectAvailable={!!project.root}
        />
      </Suspense>
      {diff.node}
    </div>
  );
}

function guessLangFromPath(path: string): string {
  const m = /\.([^./]+)$/.exec(path);
  if (!m) return "plaintext";
  const ext = m[1].toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    cs: "csharp",
    cpp: "cpp",
    c: "c",
    h: "c",
    hpp: "cpp",
    sh: "shell",
    bash: "shell",
    sql: "sql",
    html: "html",
    css: "css",
    scss: "scss",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    md: "markdown",
  };
  return map[ext] ?? ext;
}
