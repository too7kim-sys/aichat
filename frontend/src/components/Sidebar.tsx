import { useEffect, useState, type ReactNode } from "react";
import { queueAttachment } from "../state/attachQueue";
import { useWorkspaces } from "../state/WorkspacesContext";
import type { Session } from "../types";
import { CodeWorkspaceModal } from "./CodeWorkspaceModal";
import {
  IconChat,
  IconCode,
  IconFileText,
  IconFolder,
  IconGitBranch,
  IconPlus,
  IconRefresh,
} from "./Icon";

export type Workspace = "chat" | "code";

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

// Cowork (RAG project management) was folded into the admin
// "지식베이스" panel — knowledge bases are now admin-managed + role-
// mapped and auto-used in chat, so the standalone Cowork tab is gone.
const TABS: { id: Workspace; label: string; icon: ReactNode }[] = [
  { id: "chat", label: "Chat", icon: <IconChat size={18} /> },
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
