import { useEffect, useState, type ReactNode } from "react";
import { queueAttachment } from "../state/attachQueue";
import { useProjects } from "../state/ProjectsContext";
import { useWorkspaces } from "../state/WorkspacesContext";
import type { Session } from "../types";
import { CodeWorkspaceModal } from "./CodeWorkspaceModal";
import {
  IconChat,
  IconCode,
  IconDatabase,
  IconFileText,
  IconFolder,
  IconGitBranch,
  IconGlobe,
  IconPlus,
  IconRefresh,
  IconSend,
  IconUsers,
  IconX,
} from "./Icon";
import { ProjectModal } from "./ProjectModal";

export type Workspace = "chat" | "cowork" | "code";

interface Props {
  /** Extra className applied to the root <aside> — used by the parent
   *  to toggle "open" state for the mobile drawer overlay. */
  className?: string;
  workspace: Workspace;
  onWorkspaceChange: (w: Workspace) => void;
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  /** Click on a Code workspace card → create a chat named after the
   *  workspace and pre-attach a representative slice of its files. */
  onStartChatFromWorkspace: (workspaceId: string) => Promise<void> | void;
}

function groupByDate(sessions: Session[]) {
  const now = Date.now();
  const today: Session[] = [];
  const yesterday: Session[] = [];
  const lastWeek: Session[] = [];
  const earlier: Session[] = [];

  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const weekStart = todayStart - 7 * 24 * 60 * 60 * 1000;

  for (const s of sessions) {
    const t = new Date(s.updated_at).getTime();
    if (t >= todayStart) today.push(s);
    else if (t >= yesterdayStart) yesterday.push(s);
    else if (t >= weekStart) lastWeek.push(s);
    else earlier.push(s);
  }
  return { today, yesterday, lastWeek, earlier };
}

const TABS: { id: Workspace; label: string; icon: ReactNode }[] = [
  { id: "chat", label: "Chat", icon: <IconChat size={18} /> },
  { id: "cowork", label: "Cowork", icon: <IconUsers size={18} /> },
  { id: "code", label: "Code", icon: <IconCode size={18} /> },
];

export function Sidebar({
  className = "",
  workspace,
  onWorkspaceChange,
  sessions,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onStartChatFromWorkspace,
}: Props) {
  return (
    <aside className={`sidebar${className ? " " + className : ""}`}>
      <nav className="workspace-tabs" role="tablist" aria-label="Workspace">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={workspace === t.id}
            className={`workspace-tab${workspace === t.id ? " active" : ""}`}
            onClick={() => onWorkspaceChange(t.id)}
          >
            <span className="workspace-tab-icon" aria-hidden>
              {t.icon}
            </span>
            <span className="workspace-tab-label">{t.label}</span>
          </button>
        ))}
      </nav>

      {workspace === "chat" && (
        <ChatPane
          sessions={sessions}
          activeId={activeId}
          onSelect={onSelect}
          onCreate={onCreate}
          onDelete={onDelete}
        />
      )}
      {workspace === "cowork" && <CoworkPane activeSessionId={activeId} />}
      {workspace === "code" && (
        <CodePane
          activeSessionId={activeId}
          onCreateSession={onCreate}
          onStartChatFromWorkspace={onStartChatFromWorkspace}
        />
      )}
    </aside>
  );
}

function ChatPane({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onDelete,
}: {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}) {
  const groups = groupByDate(sessions);
  return (
    <>
      <div className="sidebar-actions">
        <button className="primary" onClick={onCreate}>
          + 새 대화
        </button>
      </div>
      <div className="sidebar-sessions">
        <SessionGroup
          label="오늘"
          sessions={groups.today}
          {...{ activeId, onSelect, onDelete }}
        />
        <SessionGroup
          label="어제"
          sessions={groups.yesterday}
          {...{ activeId, onSelect, onDelete }}
        />
        <SessionGroup
          label="지난 7일"
          sessions={groups.lastWeek}
          {...{ activeId, onSelect, onDelete }}
        />
        <SessionGroup
          label="이전"
          sessions={groups.earlier}
          {...{ activeId, onSelect, onDelete }}
        />
      </div>
    </>
  );
}

function CoworkPane({ activeSessionId }: { activeSessionId: string | null }) {
  const { projects, refresh, remove } = useProjects();
  const [modalOpen, setModalOpen] = useState(false);
  // Hydrate the current linked project for the active session so the
  // modal can show ✓ on the correct card. Stay in sync with custom
  // events fired by the modal so the badge updates without remount.
  const linkKey = activeSessionId
    ? `chat:session:${activeSessionId}:project`
    : null;
  const [linkedProjectId, setLinkedProjectId] = useState<string | null>(
    () => (linkKey ? localStorage.getItem(linkKey) : null),
  );
  useEffect(() => {
    setLinkedProjectId(linkKey ? localStorage.getItem(linkKey) : null);
  }, [linkKey]);

  function applyLink(projectId: string | null) {
    if (!activeSessionId || !linkKey) return;
    setLinkedProjectId(projectId);
    if (projectId) localStorage.setItem(linkKey, projectId);
    else localStorage.removeItem(linkKey);
    window.dispatchEvent(
      new CustomEvent("chat:project-linked", {
        detail: { sessionId: activeSessionId, projectId },
      }),
    );
  }

  function statusLabel(p: { status: string; progress_done: number; progress_total: number }): string {
    switch (p.status) {
      case "ready":
        return "준비됨";
      case "indexing": {
        const pct = p.progress_total
          ? Math.round((100 * p.progress_done) / p.progress_total)
          : 0;
        return `인덱싱 ${pct}%`;
      }
      case "pending":
        return "대기";
      case "failed":
        return "실패";
      default:
        return p.status;
    }
  }

  return (
    <>
      <div className="sidebar-actions">
        <button className="primary" onClick={() => setModalOpen(true)}>
          + 프로젝트 추가
        </button>
      </div>
      <div className="sidebar-sessions">
        <div className="session-section">RAG 프로젝트</div>
        {projects.length === 0 ? (
          <div className="sidebar-empty">
            문서(PDF·DOCX·MD), OpenAPI, DB 스키마를 한 번 인덱싱해두면 채팅에서
            자연어로 검색할 수 있어요. 코드 분석은 사이드바의 <b>Code 탭</b>을
            사용하세요.
          </div>
        ) : (
          <ul className="proj-sidebar-list">
            {projects.map((p) => (
              <li
                key={p.id}
                className={`proj-sidebar-item status-${p.status}`}
                onClick={() => setModalOpen(true)}
              >
                <div className="proj-sidebar-row">
                  <div className="proj-sidebar-name">
                    <span className="proj-sidebar-name-icon" aria-hidden>
                      {p.source_type === "git" ? (
                        <IconGitBranch size={14} />
                      ) : p.source_type === "url" ||
                        p.source_type === "sftp" ? (
                        <IconGlobe size={14} />
                      ) : p.source_type === "connection" ? (
                        <IconDatabase size={14} />
                      ) : (
                        <IconFolder size={14} />
                      )}
                    </span>
                    {p.name}
                  </div>
                  <button
                    type="button"
                    className="proj-sidebar-del"
                    aria-label="삭제"
                    title="삭제"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (
                        !window.confirm(
                          `"${p.name}"을(를) 삭제할까요?\n인덱스도 함께 사라지고 디스크 공간이 회수됩니다.`,
                        )
                      )
                        return;
                      try {
                        await remove(p.id);
                      } catch (err) {
                        window.alert(
                          `삭제 실패: ${err instanceof Error ? err.message : String(err)}`,
                        );
                      }
                    }}
                  >
                    <IconX size={14} />
                  </button>
                </div>
                <div className="proj-sidebar-meta">
                  <span className={`proj-sidebar-status ${p.status}`}>
                    {statusLabel(p)}
                  </span>
                  {p.status === "ready" && (
                    <span className="proj-sidebar-counts">
                      {p.file_count}f · {p.chunk_count}c
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ProjectModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          refresh();
        }}
        linkSessionId={activeSessionId}
        linkedProjectId={linkedProjectId}
        onLinkChange={applyLink}
      />
    </>
  );
}

function CodePane({
  activeSessionId,
  onCreateSession,
  onStartChatFromWorkspace,
}: {
  activeSessionId: string | null;
  onCreateSession: () => void;
  onStartChatFromWorkspace: (workspaceId: string) => Promise<void> | void;
}) {
  const { workspaces, refresh, sync } = useWorkspaces();
  const [modalOpen, setModalOpen] = useState(false);
  // Track which card is currently spinning up its chat, so the row
  // can disable itself + show the right status.
  const [startingId, setStartingId] = useState<string | null>(null);

  async function startChat(workspaceId: string) {
    if (startingId) return;
    setStartingId(workspaceId);
    try {
      await onStartChatFromWorkspace(workspaceId);
    } finally {
      setStartingId(null);
    }
  }

  return (
    <>
      <div className="sidebar-actions">
        <button className="primary" onClick={() => setModalOpen(true)}>
          <IconPlus size={14} />
          <span>워크스페이스</span>
        </button>
      </div>
      <div className="sidebar-sessions">
        <div className="session-section">Code workspaces</div>
        {workspaces.length === 0 ? (
          <div className="sidebar-empty">
            사내 Git 레포를 clone해 코드 분석·수정 흐름을 시작하세요. 카드를
            클릭하면 프로젝트 전체가 새 채팅에 자동 첨부됩니다.
          </div>
        ) : (
          <ul className="proj-sidebar-list">
            {workspaces.map((w) => {
              const ready = w.status === "ready";
              const starting = startingId === w.id;
              return (
                <li
                  key={w.id}
                  className={`proj-sidebar-item status-${w.status}${
                    starting ? " busy" : ""
                  }${ready ? " clickable" : ""}`}
                  onClick={() => ready && startChat(w.id)}
                  title={
                    ready
                      ? "클릭: 이 프로젝트로 새 채팅 시작 (전체 파일 자동 첨부)"
                      : undefined
                  }
                >
                  <div className="proj-sidebar-row">
                    <div className="proj-sidebar-name">
                      <span className="proj-sidebar-name-icon" aria-hidden>
                        {w.source_type === "local" ? (
                          <IconFolder size={14} />
                        ) : (
                          <IconGitBranch size={14} />
                        )}
                      </span>
                      {w.name}
                    </div>
                    <div className="proj-sidebar-row-actions">
                      <button
                        type="button"
                        className="proj-sidebar-del"
                        aria-label="파일 보기"
                        title="파일 트리 열기"
                        onClick={(e) => {
                          e.stopPropagation();
                          setModalOpen(true);
                        }}
                      >
                        <IconFileText size={12} />
                      </button>
                      <button
                        type="button"
                        className="proj-sidebar-del"
                        aria-label={
                          w.source_type === "local"
                            ? "트리 새로고침"
                            : "동기화"
                        }
                        title={
                          w.source_type === "local"
                            ? "트리 새로고침"
                            : "동기화 (git pull)"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          sync(w.id);
                        }}
                      >
                        <IconRefresh size={12} />
                      </button>
                    </div>
                  </div>
                  <div className="proj-sidebar-meta">
                    <span className={`proj-sidebar-status ${w.status}`}>
                      {starting
                        ? "채팅 준비 중…"
                        : w.status === "ready"
                        ? "준비됨"
                        : w.status === "cloning"
                        ? "클론 중…"
                        : "실패"}
                    </span>
                    {w.status === "ready" && (
                      <span className="proj-sidebar-counts">
                        {w.file_count}f
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <CodeWorkspaceModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          refresh();
        }}
        onAttachFile={(filename, text) => {
          queueAttachment({ filename, text });
          if (!activeSessionId) {
            onCreateSession();
          }
        }}
      />
    </>
  );
}

/** Monochrome SVG glyph per session row. Code-focused sessions get
 *  the code icon; everything else gets a generic chat-bubble icon
 *  that picks up the surrounding text color via currentColor stroke.
 *  We used to render colored emojis here for topic-based variety but
 *  the saturation distracted from the title text. */
function SessionIcon({ session }: { session: Session }) {
  if (session.code_focused) return <IconCode size={14} />;
  return <IconChat size={14} />;
}

function SessionGroup({
  label,
  sessions,
  activeId,
  onSelect,
  onDelete,
}: {
  label: string;
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <>
      <div className="session-section">{label}</div>
      <ul className="session-list">
        {sessions.map((s) => (
          <li
            key={s.id}
            className={s.id === activeId ? "active" : ""}
            onClick={() => onSelect(s.id)}
          >
            <span className="session-emoji" aria-hidden="true">
              <SessionIcon session={s} />
            </span>
            <span className="session-title">{s.title}</span>
            <button
              className="delete-btn"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
              }}
              aria-label="삭제"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
