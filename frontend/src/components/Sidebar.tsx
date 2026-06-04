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
  IconFolder,
  IconGitBranch,
  IconGlobe,
  IconPlus,
  IconRefresh,
  IconUsers,
  IconX,
} from "./Icon";
import { ProjectModal } from "./ProjectModal";

export type Workspace = "chat" | "cowork" | "code";

interface Props {
  workspace: Workspace;
  onWorkspaceChange: (w: Workspace) => void;
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
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
  workspace,
  onWorkspaceChange,
  sessions,
  activeId,
  onSelect,
  onCreate,
  onDelete,
}: Props) {
  return (
    <aside className="sidebar">
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
        <CodePane activeSessionId={activeId} onCreateSession={onCreate} />
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
            전자정부 같은 큰 코드베이스를 한 번 인덱싱해두면, 채팅에서 자연어로
            검색·분석할 수 있어요.
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
}: {
  activeSessionId: string | null;
  onCreateSession: () => void;
}) {
  const { workspaces, refresh, sync } = useWorkspaces();
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <div className="sidebar-actions">
        <button className="primary" onClick={() => setModalOpen(true)}>
          <IconPlus size={14} />
          <span>+ 워크스페이스</span>
        </button>
      </div>
      <div className="sidebar-sessions">
        <div className="session-section">Code workspaces</div>
        {workspaces.length === 0 ? (
          <div className="sidebar-empty">
            사내 Git 레포를 clone해 코드 분석·수정 흐름을 시작하세요. (Phase 1
            — 보기/첨부 / Phase 2~4: AI 수정·커밋·테스트 자동화)
          </div>
        ) : (
          <ul className="proj-sidebar-list">
            {workspaces.map((w) => (
              <li
                key={w.id}
                className={`proj-sidebar-item status-${w.status}`}
                onClick={() => setModalOpen(true)}
              >
                <div className="proj-sidebar-row">
                  <div className="proj-sidebar-name">
                    <span className="proj-sidebar-name-icon" aria-hidden>
                      <IconGitBranch size={14} />
                    </span>
                    {w.name}
                  </div>
                  <button
                    type="button"
                    className="proj-sidebar-del"
                    aria-label="동기화"
                    title="동기화 (git pull)"
                    onClick={(e) => {
                      e.stopPropagation();
                      sync(w.id);
                    }}
                  >
                    <IconRefresh size={12} />
                  </button>
                </div>
                <div className="proj-sidebar-meta">
                  <span className={`proj-sidebar-status ${w.status}`}>
                    {w.status === "ready"
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
            ))}
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
          // When no chat is active, spin one up so the queued
          // attachment has somewhere to land. The fresh ChatPanel's
          // mount-effect drains the queue. App.tsx hands us the
          // create-session callback that also flips activeId, which
          // triggers the new ChatPanel to mount.
          if (!activeSessionId) {
            onCreateSession();
          }
        }}
      />
    </>
  );
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
