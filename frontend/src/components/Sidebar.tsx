import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  api,
  type Project,
  type Prompt,
  type Transcript,
  type Workflow,
} from "../api/client";
import { queueAttachment } from "../state/attachQueue";
import { errorToast } from "../lib/toast";
import { useAuth } from "../auth/AuthContext";
import { useWorkspaces } from "../state/WorkspacesContext";
import type { ChatProject, Session } from "../types";
import { CodeWorkspaceModal } from "./CodeWorkspaceModal";
import { ChatProjectEditModal } from "./ChatProjectEditModal";
import { TrashModal } from "./TrashModal";
import { PromptEditModal } from "./PromptEditModal";
import { TranscriptExportModal } from "./TranscriptExportModal";
import { WorkflowEditModal } from "./WorkflowEditModal";
import {
  IconBookOpen,
  IconChat,
  IconCheckCircle,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconCode,
  IconEdit,
  IconFileText,
  IconFolder,
  IconGitBranch,
  IconPlus,
  IconRefresh,
  IconSparkles,
  IconTrash,
  IconUsers,
  IconX,
} from "./Icon";

export type Workspace = "chat" | "cowork" | "code";

interface Props {
  /** Extra className applied to the root <aside> — used by the parent
   *  to toggle "open" state for the mobile drawer overlay. */
  className?: string;
  workspace: Workspace;
  onWorkspaceChange: (w: Workspace) => void;
  sessions: Session[];
  activeId: string | null;
  /** Sidebar folders that group related sessions. Optional — pre-API
   *  backends just return an empty list and the pane falls back to
   *  the flat date groups. */
  chatProjects?: ChatProject[];
  onSelect: (id: string) => void;
  /** Create a new session. When a chat project id is passed, the
   *  session is filed under that folder (e.g. clicking "+ 새 대화"
   *  inside a project header). */
  onCreate: (chatProjectId?: string | null) => void;
  onDelete: (id: string) => void;
  /** Click on a Code workspace card → create a chat named after the
   *  workspace and pre-attach a representative slice of its files. */
  onStartChatFromWorkspace: (workspaceId: string) => Promise<void> | void;
  /** Refresh the chat-session list — the Cowork pane calls this after
   *  a workflow run completes so the freshly-created session appears
   *  in the sidebar without a page reload. */
  onSessionRefresh?: () => Promise<void> | void;
  /** Refresh the chat-project list — called by ChatPane after a
   *  create / rename / delete so counts + names stay live. */
  onChatProjectsRefresh?: () => Promise<void> | void;
}

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `${m}:${ss}`;
}

const STATUS_LABEL: Record<Transcript["status"], string> = {
  pending: "대기",
  transcribing: "전사 중",
  diarizing: "화자 분리 중",
  summarizing: "요약 중",
  ok: "완료",
  failed: "실패",
  // Orphan rows — audio Transcript record was deleted but the
  // chat session (회의록) still lives. Keep showing them so the
  // meeting doesn't vanish from Cowork.
  archived: "보관됨",
};


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

// Cowork hosts the shared prompt library + workflow automation. RAG
// project management moved to the admin "지식베이스" panel; Cowork
// is now where users browse prompts and schedule workflow runs.
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
  chatProjects = [],
  onSelect,
  onCreate,
  onDelete,
  onStartChatFromWorkspace,
  onSessionRefresh,
  onChatProjectsRefresh,
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
          chatProjects={chatProjects}
          onSelect={onSelect}
          onCreate={onCreate}
          onDelete={onDelete}
          onChatProjectsRefresh={onChatProjectsRefresh}
          onSessionRefresh={onSessionRefresh}
        />
      )}
      {workspace === "cowork" && (
        <CoworkPane
          onSessionRefresh={onSessionRefresh}
          onOpenSession={onSelect}
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
  chatProjects,
  onSelect,
  onCreate,
  onDelete,
  onChatProjectsRefresh,
  onSessionRefresh,
}: {
  sessions: Session[];
  activeId: string | null;
  chatProjects: ChatProject[];
  onSelect: (id: string) => void;
  onCreate: (chatProjectId?: string | null) => void;
  onDelete: (id: string) => void;
  onChatProjectsRefresh?: () => Promise<void> | void;
  onSessionRefresh?: () => Promise<void> | void;
}) {
  // 사이드바 상단 '핀 고정' 섹션 (#29) + 휴지통 모달 (#31) 상태.
  const pinned = sessions.filter((s) => s.pinned);
  const [trashOpen, setTrashOpen] = useState(false);
  // Unassigned sessions still fall into the date-bucketed groups so
  // a brand-new install (no projects yet) looks unchanged. 고정된
  // 세션은 상단의 별도 핀 섹션에서만 보여 중복 표시 방지.
  const unassigned = sessions.filter(
    (s) => !s.chat_project_id && !s.pinned,
  );
  const groups = groupByDate(unassigned);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Restore the open/closed state across reloads — the user's mental
  // map of which folder they're in shouldn't reset on refresh.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("chat:projectExpanded");
      if (raw) setExpanded(JSON.parse(raw));
    } catch {
      /* private mode — fine */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("chat:projectExpanded", JSON.stringify(expanded));
    } catch {
      /* private mode — fine */
    }
  }, [expanded]);
  const [editProject, setEditProject] = useState<ChatProject | "new" | null>(
    null,
  );

  // Group filed sessions by project for O(1) lookup when rendering.
  const sessionsByProject: Record<string, Session[]> = {};
  for (const s of sessions) {
    if (!s.chat_project_id) continue;
    (sessionsByProject[s.chat_project_id] ||= []).push(s);
  }

  // Shared rename + move-session handlers wired through every group.
  // Both refresh the sidebar list afterwards so the new title / new
  // location is visible without a page reload.
  async function renameSession(sessionId: string, newTitle: string) {
    await api.updateSession(sessionId, newTitle);
    await onSessionRefresh?.();
  }
  async function moveSession(
    sessionId: string,
    targetId: string | null,
  ) {
    try {
      await api.moveSessionToChatProject(sessionId, targetId);
    } catch (e) {
      errorToast("작업 실패", e);
      return;
    }
    await Promise.all([onChatProjectsRefresh?.(), onSessionRefresh?.()]);
  }

  return (
    <>
      <div className="sidebar-actions">
        <button className="primary" onClick={() => onCreate(null)}>
          + 새 대화
        </button>
        <button
          type="button"
          className="sidebar-trash-btn"
          onClick={() => setTrashOpen(true)}
          title="휴지통 — 최근 삭제된 대화 (30일 보관)"
        >
          🗑
        </button>
      </div>
      <div className="sidebar-sessions">
        <SessionGroup
          label="📌 고정"
          sessions={pinned}
          chatProjects={chatProjects}
          {...{ activeId, onSelect, onDelete }}
          onRename={renameSession}
          onMoveSession={moveSession}
          onSessionRefresh={onSessionRefresh}
        />
        {/* Projects — sidebar folders. Each header expands to reveal
          * its sessions plus a "+ 새 대화" affordance that creates a
          * session pre-filed into that folder. The "+" on the section
          * header opens the create / edit modal. */}
        <div className="cp-section">
          <button
            type="button"
            className="cp-section-head"
            onClick={() => setEditProject("new")}
            title="새 프로젝트 만들기"
          >
            <span className="cp-section-title">
              <IconFolder size={12} /> 프로젝트{" "}
              {chatProjects.length > 0 && (
                <span className="cp-section-count">
                  ({chatProjects.length})
                </span>
              )}
            </span>
            <span className="cp-section-add" aria-label="새 프로젝트">
              <IconPlus size={12} />
            </span>
          </button>
          {chatProjects.length === 0 ? (
            <div className="cp-section-empty">
              관련된 대화를 폴더로 묶어 정리하세요.
            </div>
          ) : (
            <ul className="cp-list">
              {chatProjects.map((p) => (
                <ChatProjectRow
                  key={p.id}
                  project={p}
                  expanded={!!expanded[p.id]}
                  onToggle={() =>
                    setExpanded((m) => ({ ...m, [p.id]: !m[p.id] }))
                  }
                  childSessions={sessionsByProject[p.id] ?? []}
                  activeId={activeId}
                  onSelect={onSelect}
                  onCreate={() => onCreate(p.id)}
                  onDelete={onDelete}
                  onRename={renameSession}
                  onEdit={() => setEditProject(p)}
                  onMoveSession={moveSession}
                  onSessionRefresh={onSessionRefresh}
                  allProjects={chatProjects}
                />
              ))}
            </ul>
          )}
        </div>

        <SessionGroup
          label="오늘"
          sessions={groups.today}
          chatProjects={chatProjects}
          {...{ activeId, onSelect, onDelete }}
          onRename={renameSession}
          onMoveSession={moveSession}
          onSessionRefresh={onSessionRefresh}
        />
        <SessionGroup
          label="어제"
          sessions={groups.yesterday}
          chatProjects={chatProjects}
          {...{ activeId, onSelect, onDelete }}
          onRename={renameSession}
          onMoveSession={moveSession}
          onSessionRefresh={onSessionRefresh}
        />
        <SessionGroup
          label="지난 7일"
          sessions={groups.lastWeek}
          chatProjects={chatProjects}
          {...{ activeId, onSelect, onDelete }}
          onRename={renameSession}
          onMoveSession={moveSession}
          onSessionRefresh={onSessionRefresh}
        />
        <SessionGroup
          label="이전"
          sessions={groups.earlier}
          chatProjects={chatProjects}
          {...{ activeId, onSelect, onDelete }}
          onRename={renameSession}
          onMoveSession={moveSession}
          onSessionRefresh={onSessionRefresh}
        />
      </div>

      {editProject !== null && (
        <ChatProjectEditModal
          project={editProject === "new" ? null : editProject}
          onClose={() => setEditProject(null)}
          onSaved={async () => {
            setEditProject(null);
            await onChatProjectsRefresh?.();
          }}
          onDeleted={async () => {
            setEditProject(null);
            await Promise.all([
              onChatProjectsRefresh?.(),
              onSessionRefresh?.(),
            ]);
          }}
        />
      )}
      {trashOpen && (
        <TrashModal
          onClose={() => setTrashOpen(false)}
          onChanged={onSessionRefresh}
        />
      )}
    </>
  );
}


function ChatProjectRow({
  project,
  expanded,
  onToggle,
  childSessions,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onEdit,
  onMoveSession,
  onSessionRefresh,
  allProjects,
}: {
  project: ChatProject;
  expanded: boolean;
  onToggle: () => void;
  childSessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (sessionId: string, newTitle: string) => void | Promise<void>;
  onEdit: () => void;
  onMoveSession: (
    sessionId: string,
    targetProjectId: string | null,
  ) => void | Promise<void>;
  onSessionRefresh?: () => Promise<void> | void;
  allProjects: ChatProject[];
}) {
  const containsActive =
    !!activeId && childSessions.some((s) => s.id === activeId);
  return (
    <li className={`cp-item${containsActive ? " contains-active" : ""}`}>
      <div className="cp-item-head">
        <button
          type="button"
          className="cp-item-toggle"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? "접기" : "펼치기"}
        >
          {expanded ? (
            <IconChevronDown size={12} />
          ) : (
            <IconChevronRight size={12} />
          )}
        </button>
        <button
          type="button"
          className="cp-item-name"
          onClick={onToggle}
          title={project.description || project.name}
        >
          <IconFolder size={12} />
          <span>{project.name}</span>
          <span className="cp-item-count">{childSessions.length}</span>
        </button>
        <button
          type="button"
          className="cp-item-action"
          onClick={onEdit}
          title="편집"
          aria-label="편집"
        >
          <IconEdit size={11} />
        </button>
      </div>
      {expanded && (
        <ul className="cp-children">
          <li className="cp-child cp-child-add">
            <button
              type="button"
              className="cp-child-add-btn"
              onClick={onCreate}
            >
              <IconPlus size={11} /> 새 대화
            </button>
          </li>
          {childSessions.length === 0 ? (
            <li className="cp-child-empty">아직 대화가 없습니다.</li>
          ) : (
            childSessions
              .slice()
              .sort(
                (a, b) =>
                  new Date(b.updated_at).getTime() -
                  new Date(a.updated_at).getTime(),
              )
              .map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === activeId}
                  onSelect={() => onSelect(s.id)}
                  onDelete={() => onDelete(s.id)}
                  onRename={onRename}
                  chatProjects={allProjects}
                  onMoveSession={onMoveSession}
                  onSessionRefresh={onSessionRefresh}
                  compact
                />
              ))
          )}
        </ul>
      )}
    </li>
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
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                className="primary"
                onClick={() => setModalOpen(true)}
              >
                <IconPlus size={14} /> 첫 워크스페이스 추가
              </button>
            </div>
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
  chatProjects,
  onSelect,
  onDelete,
  onRename,
  onMoveSession,
  onSessionRefresh,
}: {
  label: string;
  sessions: Session[];
  activeId: string | null;
  chatProjects: ChatProject[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (sessionId: string, newTitle: string) => void | Promise<void>;
  onMoveSession: (
    sessionId: string,
    targetProjectId: string | null,
  ) => void | Promise<void>;
  onSessionRefresh?: () => Promise<void> | void;
}) {
  if (sessions.length === 0) return null;
  return (
    <>
      <div className="session-section">{label}</div>
      <ul className="session-list">
        {sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === activeId}
            onSelect={() => onSelect(s.id)}
            onDelete={() => onDelete(s.id)}
            onRename={onRename}
            chatProjects={chatProjects}
            onMoveSession={onMoveSession}
            onSessionRefresh={onSessionRefresh}
          />
        ))}
      </ul>
    </>
  );
}


/** One row in the sidebar session list. Used both at the top level
 *  (date-grouped) and nested inside a chat project. Exposes a small
 *  "프로젝트 변경" menu that lets the user file the session into a
 *  folder (or detach it back to the date groups). */
function SessionRow({
  session: s,
  active,
  onSelect,
  onDelete,
  onRename,
  chatProjects,
  onMoveSession,
  onSessionRefresh,
  compact = false,
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  /** Rename the session. Implemented by the parent so the API call
   *  is paired with the right post-update refresh (sidebar list +
   *  active chat header). When omitted the rename affordance is
   *  hidden. */
  onRename?: (sessionId: string, newTitle: string) => void | Promise<void>;
  chatProjects: ChatProject[];
  onMoveSession: (
    sessionId: string,
    targetProjectId: string | null,
  ) => void | Promise<void>;
  /** 고정 토글이 끝난 뒤 sidebar 를 다시 불러올 콜백. */
  onSessionRefresh?: () => Promise<void> | void;
  compact?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Inline rename. Activated from the row menu OR by double-clicking
  // the title — same edit path either way so users with either habit
  // land somewhere familiar.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.title);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);
  // Auto-focus + select-all when the row enters edit mode so the
  // user can just start typing the new title.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  // Re-seed the draft whenever the underlying session's title changes
  // out from under us (e.g., the chat router's auto-title rename
  // fires while the user has the row in view but not in edit mode).
  useEffect(() => {
    if (!editing) setDraft(s.title);
  }, [s.title, editing]);

  function startEdit() {
    if (!onRename) return;
    setDraft(s.title);
    setEditing(true);
  }
  async function commitEdit() {
    const next = draft.trim();
    if (!next || next === s.title || !onRename) {
      setEditing(false);
      setDraft(s.title);
      return;
    }
    setBusy(true);
    try {
      await onRename(s.id, next);
      setEditing(false);
    } catch (e) {
      errorToast("이름 변경 실패", e);
    } finally {
      setBusy(false);
    }
  }
  function cancelEdit() {
    setEditing(false);
    setDraft(s.title);
  }

  async function togglePin() {
    try {
      await api.pinSession(s.id, !s.pinned);
      await onSessionRefresh?.();
    } catch (e) {
      errorToast("고정 토글 실패", e);
    }
  }

  return (
    <li
      className={`${active ? "active" : ""}${compact ? " cp-child" : ""}${
        editing ? " editing" : ""
      }${s.pinned ? " pinned" : ""}`}
      onClick={editing ? undefined : onSelect}
    >
      <span className="session-emoji" aria-hidden="true">
        <SessionIcon session={s} />
      </span>
      {s.pinned && (
        <span className="session-pin-badge" title="고정됨" aria-hidden="true">
          📌
        </span>
      )}
      {editing ? (
        <input
          ref={inputRef}
          className="session-title-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            }
          }}
          maxLength={200}
          disabled={busy}
        />
      ) : (
        <span
          className="session-title"
          title={s.title}
          onDoubleClick={(e) => {
            // Double-click is a power-user shortcut — only wire it up
            // when the row supports rename at all.
            if (!onRename) return;
            e.stopPropagation();
            startEdit();
          }}
        >
          {s.title}
        </span>
      )}
      <div
        className="session-row-actions"
        ref={menuRef}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="session-row-move"
          aria-label="옵션"
          title="옵션"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <IconFolder size={11} />
        </button>
        {menuOpen && (
          <div className="session-row-menu">
            {onRename && (
              <>
                <button
                  type="button"
                  className="session-row-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    startEdit();
                  }}
                >
                  <IconEdit size={11} /> 이름 변경
                </button>
                <button
                  type="button"
                  className="session-row-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    togglePin();
                  }}
                >
                  📌 {s.pinned ? "고정 해제" : "상단 고정"}
                </button>
                <div className="session-row-menu-sep" />
              </>
            )}
            <div className="session-row-menu-title">프로젝트로 이동</div>
            {chatProjects.length === 0 ? (
              <div className="session-row-menu-empty">
                프로젝트가 없습니다.
              </div>
            ) : (
              chatProjects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`session-row-menu-item${
                    s.chat_project_id === p.id ? " current" : ""
                  }`}
                  onClick={async () => {
                    setMenuOpen(false);
                    await onMoveSession(s.id, p.id);
                  }}
                >
                  <IconFolder size={11} /> {p.name}
                </button>
              ))
            )}
            {s.chat_project_id && (
              <button
                type="button"
                className="session-row-menu-item detach"
                onClick={async () => {
                  setMenuOpen(false);
                  await onMoveSession(s.id, null);
                }}
              >
                <IconX size={11} /> 프로젝트에서 빼기
              </button>
            )}
          </div>
        )}
        <button
          className="delete-btn"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="삭제"
        >
          ×
        </button>
      </div>
    </li>
  );
}


type CoworkSection = "meetings" | "workflows" | "prompts" | "knowledge";

function CoworkPane({
  onSessionRefresh,
  onOpenSession,
}: {
  onSessionRefresh?: () => Promise<void> | void;
  onOpenSession: (id: string) => void;
}) {
  // 회의록 / 워크플로 / 프롬프트 / 지식베이스 — 4-way menu replacing the
  // earlier horizontal tab bar. Vertical stack inside a slim header so
  // a fixed 260px sidebar can still fit four entries comfortably; the
  // active section's content renders below.
  const [tab, setTab] = useState<CoworkSection>(() => {
    const stored = localStorage.getItem("cowork:section");
    if (
      stored === "meetings" || stored === "workflows" ||
      stored === "prompts" || stored === "knowledge"
    ) {
      return stored;
    }
    return "meetings";
  });
  useEffect(() => {
    localStorage.setItem("cowork:section", tab);
  }, [tab]);
  // Knowledge (RAG) entry opens the existing ProjectModal in embedded
  // mode — same UI the admin panel renders, just without adminMode so
  // the operator gets owner-only controls.
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [knowledgeAddOpen, setKnowledgeAddOpen] = useState(false);
  // When set, CoworkKnowledgeModal opens directly into this project's
  // detail view — clicked from the sidebar's 내/공유 지식베이스 row.
  const [knowledgeProjectId, setKnowledgeProjectId] = useState<string | null>(
    null,
  );
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  // Projects + auth feed the workflow editor — the prompt dropdown
  // wants RAG bases for the optional retrieval pin, the prompt
  // editor needs the admin flag for the share toggle.
  const [projects, setProjects] = useState<Project[]>([]);
  const { user: me } = useAuth();
  const isAdmin = me?.role === "admin";
  // Edit modals — "new" sentinel opens an empty form, an instance
  // opens the editor seeded from that row.
  const [promptEdit, setPromptEdit] = useState<Prompt | "new" | null>(null);
  const [workflowEdit, setWorkflowEdit] = useState<Workflow | "new" | null>(
    null,
  );
  // Transcript export selection modal — opened from the 📄 button
  // on a meetings row. The user picks which messages to include
  // (defaults to assistant-only) and downloads as DOCX.
  const [exportTranscript, setExportTranscript] = useState<Transcript | null>(
    null,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // MediaRecorder state for the live record button.
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const [recordStartedAt, setRecordStartedAt] = useState<number | null>(null);
  const [recordElapsedSec, setRecordElapsedSec] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function refreshAll() {
    try {
      const [p, w, t, pr] = await Promise.all([
        api.listPrompts(),
        api.listWorkflows(),
        api.listTranscripts().catch(() => [] as Transcript[]),
        api.listProjects().catch(() => [] as Project[]),
      ]);
      setPrompts(p);
      setWorkflows(w);
      setTranscripts(t);
      setProjects(pr);
    } catch {
      /* unauthorized — empty */
    }
  }

  // Record-time tick.
  useEffect(() => {
    if (!recording || recordStartedAt === null) return;
    const id = window.setInterval(() => {
      setRecordElapsedSec(
        Math.floor((Date.now() - recordStartedAt) / 1000),
      );
    }, 500);
    return () => window.clearInterval(id);
  }, [recording, recordStartedAt]);

  // Poll while any transcript is mid-pipeline so progress / status
  // bubble up to the UI in near-real-time. Stops as soon as nothing
  // is in flight.
  useEffect(() => {
    const inFlight = transcripts.some(
      (t) => !["ok", "failed", "archived"].includes(t.status),
    );
    if (!inFlight) return;
    const id = window.setInterval(async () => {
      const next = await api.listTranscripts().catch(() => null);
      if (next) {
        setTranscripts(next);
        const stillInFlight = next.some(
          (t) => !["ok", "failed", "archived"].includes(t.status),
        );
        if (!stillInFlight) {
          await onSessionRefresh?.();
        }
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [transcripts, onSessionRefresh]);

  async function startRecording() {
    if (recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      recordChunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordChunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordChunksRef.current, {
          type: recordChunksRef.current[0]?.type || "audio/webm",
        });
        recordChunksRef.current = [];
        await uploadBlob(blob, `녹음-${new Date().toISOString().slice(0, 16)}.webm`);
      };
      rec.start(1000);
      recorderRef.current = rec;
      setRecording(true);
      setRecordStartedAt(Date.now());
      setRecordElapsedSec(0);
    } catch (e) {
      errorToast("마이크 접근 실패", e);
    }
  }

  function stopRecording() {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    recorderRef.current = null;
    setRecording(false);
    setRecordStartedAt(null);
  }

  async function uploadBlob(blob: Blob, filename: string) {
    if (uploading) return;
    setUploading(true);
    try {
      await api.uploadTranscript(blob, filename);
      await refreshAll();
    } catch (e) {
      errorToast("업로드 실패", e);
    } finally {
      setUploading(false);
    }
  }

  async function onFilePick(files: FileList | null) {
    if (!files || files.length === 0) return;
    await uploadBlob(files[0], files[0].name);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function deleteTranscript(t: Transcript) {
    const isArchived = t.status === "archived";
    const message = isArchived
      ? "보관된 회의록(채팅 세션)을 완전히 삭제할까요?\n삭제 후에는 복구할 수 없습니다."
      : "이 전사 기록을 삭제할까요?\n채팅 세션 자체는 그대로 남아 Cowork 보관 목록에 표시됩니다.";
    if (!window.confirm(message)) return;
    setBusyId(t.id);
    try {
      await api.deleteTranscript(t.id);
      await refreshAll();
      if (isArchived) {
        // Removing the underlying session — Chat sidebar needs a
        // refresh too so the row disappears there.
        await onSessionRefresh?.();
      }
    } catch (e) {
      errorToast("삭제 실패", e);
    } finally {
      setBusyId(null);
    }
  }


  useEffect(() => {
    refreshAll();
  }, []);

  // While any workflow is running, poll every 2s. The runner stamps
  // last_run_status="running" → "ok"/"failed"; we keep polling until
  // nothing's running and the new session is in the sidebar list.
  useEffect(() => {
    const anyRunning = workflows.some((w) => w.last_run_status === "running");
    if (!anyRunning) return;
    const id = window.setInterval(async () => {
      const w = await api.listWorkflows();
      setWorkflows(w);
      if (!w.some((x) => x.last_run_status === "running")) {
        await onSessionRefresh?.();
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [workflows, onSessionRefresh]);

  async function runWorkflow(w: Workflow) {
    setBusyId(w.id);
    try {
      const updated = await api.runWorkflow(w.id);
      setWorkflows((prev) =>
        prev.map((x) => (x.id === updated.id ? updated : x)),
      );
    } catch (e) {
      errorToast("실행 실패", e);
    } finally {
      setBusyId(null);
    }
  }

  const menu: {
    id: CoworkSection;
    label: string;
    icon: ReactNode;
    hint: string;
  }[] = [
    { id: "meetings", label: "회의록", icon: <IconFileText size={13} />, hint: "녹음·전사·요약" },
    { id: "workflows", label: "워크플로", icon: <IconClock size={13} />, hint: "예약·자동 실행" },
    { id: "prompts", label: "프롬프트", icon: <IconSparkles size={13} />, hint: "재사용 가능한 프롬프트" },
    { id: "knowledge", label: "지식베이스", icon: <IconBookOpen size={13} />, hint: "RAG·내 문서·공유 자료" },
  ];

  return (
    <>
      <nav className="cowork-menu" role="tablist" aria-label="Cowork 메뉴">
        {menu.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={tab === m.id}
            className={`cowork-menu-item${tab === m.id ? " active" : ""}`}
            onClick={() => setTab(m.id)}
            title={m.hint}
          >
            <span className="cowork-menu-icon" aria-hidden>{m.icon}</span>
            <span className="cowork-menu-label">{m.label}</span>
          </button>
        ))}
      </nav>

      {tab === "meetings" && (
        <div className="sidebar-sessions">
          {isAdmin && (
            <WhisperBootstrapBanner />
          )}
          <div className="sidebar-actions">
            {recording ? (
              <button className="primary recording" onClick={stopRecording}>
                ● {formatDuration(recordElapsedSec)} · 중지
              </button>
            ) : (
              <button
                className="primary"
                onClick={startRecording}
                disabled={uploading}
              >
                ● 녹음 시작
              </button>
            )}
            <button
              type="button"
              className="cowork-upload-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || recording}
              title="오디오 파일 업로드 (mp3, wav, m4a, webm 등)"
            >
              파일 업로드
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,video/mp4,.webm,.ogg,.opus,.m4a,.mp3,.wav,.flac"
              style={{ display: "none" }}
              onChange={(e) => onFilePick(e.target.files)}
            />
          </div>
          <div className="session-section">최근 전사</div>
          {uploading && (
            <div className="sidebar-empty">업로드 중…</div>
          )}
          {transcripts.length === 0 && !uploading ? (
            <div className="sidebar-empty">
              회의나 강의를 녹음하거나 오디오 파일을 업로드하면 자동으로
              전사·요약해서 새 채팅 세션으로 저장합니다.
              {(!recording && transcripts.length === 0) && (
                <>
                  <br />
                  <small style={{ display: "block", marginTop: 6 }}>
                    백엔드에 <code>faster-whisper</code> 와 <code>ENABLE_TRANSCRIPTION=true</code> 설정 필요.
                  </small>
                </>
              )}
            </div>
          ) : (
            <ul className="cowork-list">
              {transcripts.map((t) => (
                <TranscriptRow
                  key={t.id}
                  transcript={t}
                  busyId={busyId}
                  onOpen={() => t.session_id && onOpenSession(t.session_id)}
                  onDelete={() => deleteTranscript(t)}
                  onRenamed={async () => {
                    await refreshAll();
                  }}
                  onExport={() => setExportTranscript(t)}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "workflows" && (
        <div className="sidebar-sessions">
          <div className="sidebar-actions">
            <button
              className="primary"
              onClick={() => setWorkflowEdit("new")}
            >
              <IconPlus size={14} /> 새 워크플로
            </button>
          </div>
          <div className="session-section">자동화 워크플로</div>
          {workflows.length === 0 ? (
            <div className="sidebar-empty">
              프롬프트와 (선택) 지식베이스를 묶어 정해진 시각에 자동
              실행할 수 있어요. 결과는 새 채팅 세션으로 남습니다.
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="primary"
                  onClick={() => setWorkflowEdit("new")}
                >
                  <IconPlus size={14} /> 첫 워크플로 만들기
                </button>
              </div>
            </div>
          ) : (
            <ul className="cowork-list">
              {workflows.map((w) => (
                <li
                  key={w.id}
                  className={`cowork-item status-${w.last_run_status ?? "idle"} cowork-item-clickable`}
                  onClick={() => setWorkflowEdit(w)}
                >
                  <div className="cowork-item-head">
                    <span className="cowork-item-name" title={w.description ?? undefined}>
                      {w.name}
                    </span>
                    <button
                      type="button"
                      className="cowork-item-run"
                      onClick={(e) => {
                        e.stopPropagation();
                        runWorkflow(w);
                      }}
                      disabled={
                        busyId === w.id || w.last_run_status === "running"
                      }
                      title="지금 실행"
                    >
                      <IconRefresh size={13} />
                    </button>
                  </div>
                  <div className="cowork-item-meta">
                    <span>
                      {w.prompt_name ?? "?"}
                      {w.project_name ? ` · ${w.project_name}` : ""}
                      {w.schedule_interval_minutes > 0
                        ? ` · ${
                            w.schedule_interval_minutes >= 1440
                              ? "매일"
                              : w.schedule_interval_minutes >= 60
                              ? `${w.schedule_interval_minutes / 60}시간`
                              : `${w.schedule_interval_minutes}분`
                          }`
                        : " · 수동"}
                      {!w.enabled && " · 비활성"}
                    </span>
                    {w.last_run_status === "running" ? (
                      <span className="cowork-run-badge running">실행 중…</span>
                    ) : w.last_run_status === "ok" ? (
                      <button
                        type="button"
                        className="cowork-run-badge ok"
                        onClick={(e) => {
                          e.stopPropagation();
                          w.last_session_id && onOpenSession(w.last_session_id);
                        }}
                        title="마지막 결과 열기"
                      >
                        <IconCheckCircle size={11} /> 보기
                      </button>
                    ) : w.last_run_status === "failed" ? (
                      <span
                        className="cowork-run-badge failed"
                        title={w.last_error ?? "실패"}
                      >
                        실패
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "prompts" && (
        <div className="sidebar-sessions">
          <div className="sidebar-actions">
            <button
              className="primary"
              onClick={() => setPromptEdit("new")}
            >
              <IconPlus size={14} /> 새 프롬프트
            </button>
          </div>
          <div className="session-section">프롬프트 라이브러리</div>
          {prompts.length === 0 ? (
            <div className="sidebar-empty">
              자주 쓰는 질문을 템플릿으로 저장해두면 채팅 입력창에서
              <kbd>/</kbd> 키로 한 번에 끼울 수 있어요.
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="primary"
                  onClick={() => setPromptEdit("new")}
                >
                  <IconPlus size={14} /> 첫 프롬프트 만들기
                </button>
              </div>
            </div>
          ) : (
            <ul className="cowork-list">
              {prompts.map((p) => (
                <li
                  key={p.id}
                  className={`cowork-item${p.owned ? " cowork-item-clickable" : ""}`}
                  onClick={() => p.owned && setPromptEdit(p)}
                  title={p.owned ? "클릭해서 편집" : "공유 프롬프트 — 읽기 전용"}
                >
                  <div className="cowork-item-head">
                    <span className="cowork-item-name" title={p.description ?? undefined}>
                      {p.name}
                    </span>
                    {!p.owned && (
                      <span className="cowork-shared-badge">공유</span>
                    )}
                  </div>
                  <div className="cowork-item-meta">
                    {p.category && <span>{p.category}</span>}
                    {p.tags && <span>{p.tags}</span>}
                  </div>
                  <div className="cowork-item-body">
                    {p.body.slice(0, 140)}
                    {p.body.length > 140 ? "…" : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "knowledge" && (() => {
        // owned = 내가 만든 RAG 프로젝트 (관리 가능)
        // shared = 공유받은 — 읽기 전용, 채팅 시 자동 검색에 포함됨
        const owned  = projects.filter((p) => p.owned);
        const shared = projects.filter((p) => !p.owned);
        const openProject = (id: string) => {
          setKnowledgeProjectId(id);
          setKnowledgeAddOpen(false);
          setKnowledgeOpen(true);
        };
        return (
        <div className="sidebar-sessions cowork-knowledge">
          <div className="sidebar-actions">
            <button
              className="primary"
              onClick={() => {
                setKnowledgeProjectId(null);
                setKnowledgeAddOpen(true);
                setKnowledgeOpen(true);
              }}
            >
              <IconPlus size={14} /> 새 지식베이스
            </button>
            <button
              type="button"
              className="cowork-upload-btn"
              onClick={() => {
                setKnowledgeProjectId(null);
                setKnowledgeAddOpen(false);
                setKnowledgeOpen(true);
              }}
            >
              목록 / 관리
            </button>
          </div>

          {owned.length > 0 && (
            <>
              <div className="session-section">내 지식베이스</div>
              <ul className="cowork-list">
                {owned.map((p) => (
                  <KnowledgeRow
                    key={p.id}
                    project={p}
                    onOpen={() => openProject(p.id)}
                  />
                ))}
              </ul>
            </>
          )}

          {shared.length > 0 && (
            <>
              <div className="session-section">공유받은 지식베이스</div>
              <ul className="cowork-list">
                {shared.map((p) => (
                  <KnowledgeRow
                    key={p.id}
                    project={p}
                    onOpen={() => openProject(p.id)}
                  />
                ))}
              </ul>
            </>
          )}

          {owned.length === 0 && shared.length === 0 && (
            <div className="sidebar-empty cowork-knowledge-hint">
              내 문서를 업로드하거나 폴더·SFTP·DB·API를 인덱싱해서 자연어로
              검색·분석할 수 있습니다. 공유된 지식베이스는 자동으로 함께
              검색됩니다.
            </div>
          )}

          {knowledgeOpen && (
            <CoworkKnowledgeModal
              addOpen={knowledgeAddOpen}
              projectId={knowledgeProjectId}
              onClose={() => {
                setKnowledgeOpen(false);
                setKnowledgeAddOpen(false);
                setKnowledgeProjectId(null);
              }}
            />
          )}
        </div>
        );
      })()}

      {promptEdit !== null && (
        <PromptEditModal
          prompt={promptEdit === "new" ? null : promptEdit}
          isAdmin={isAdmin}
          onClose={() => setPromptEdit(null)}
          onSaved={async () => {
            setPromptEdit(null);
            await refreshAll();
          }}
          onDeleted={async () => {
            setPromptEdit(null);
            await refreshAll();
          }}
        />
      )}

      {workflowEdit !== null && (
        <WorkflowEditModal
          workflow={workflowEdit === "new" ? null : workflowEdit}
          prompts={prompts}
          projects={projects}
          onClose={() => setWorkflowEdit(null)}
          onSaved={async () => {
            setWorkflowEdit(null);
            await refreshAll();
          }}
          onDeleted={async () => {
            setWorkflowEdit(null);
            await refreshAll();
          }}
        />
      )}

      {exportTranscript && (
        <TranscriptExportModal
          transcript={exportTranscript}
          onClose={() => setExportTranscript(null)}
          onOpenChat={(sessionId) => {
            setExportTranscript(null);
            onOpenSession(sessionId);
          }}
        />
      )}
    </>
  );
}


/** Embedded RAG / 지식베이스 manager opened from Cowork. Reuses the
 *  existing ProjectModal, but never passes adminMode so the user
 *  sees only owner-mode controls — personal projects + shared ones
 *  granted to them, with create/edit/delete confined to their own. */
function CoworkKnowledgeModal({
  addOpen,
  projectId,
  onClose,
}: {
  addOpen: boolean;
  projectId?: string | null;
  onClose: () => void;
}) {
  // Lazy import to keep ProjectModal out of the sidebar's initial
  // bundle — RAG users open it on demand, not on every page load.
  const [Modal, setModal] = useState<
    React.ComponentType<{
      open: boolean;
      onClose: () => void;
      adminMode?: boolean;
      initialAddOpen?: boolean;
      initialProjectId?: string | null;
    }> | null
  >(null);
  useEffect(() => {
    let active = true;
    import("./ProjectModal").then((m) => {
      if (active) setModal(() => m.ProjectModal);
    });
    return () => {
      active = false;
    };
  }, []);
  if (!Modal) return null;
  return (
    <Modal
      open
      onClose={onClose}
      adminMode={false}
      initialAddOpen={addOpen}
      initialProjectId={projectId ?? null}
    />
  );
}


/** Single row in the Cowork knowledge list (sidebar). Mirrors the
 *  prompts/workflow row style — title + meta line + click-to-open.
 *  Owned vs shared distinction comes from the section heading the
 *  parent renders; here we just tag shared rows with a small badge. */
function KnowledgeRow({
  project: p,
  onOpen,
}: {
  project: Project;
  onOpen: () => void;
}) {
  const statusLabel: Record<Project["status"], string> = {
    pending: "대기",
    indexing: "인덱싱 중",
    ready: "준비됨",
    failed: "실패",
  };
  return (
    <li
      className={`cowork-item status-${p.status} cowork-item-clickable`}
      onClick={onOpen}
      title={p.owned ? "클릭해서 관리" : "공유 지식베이스 — 읽기 전용"}
    >
      <div className="cowork-item-head">
        <span className="cowork-item-name" title={p.source_ref || undefined}>
          {p.name}
        </span>
        {!p.owned && <span className="cowork-shared-badge">공유</span>}
      </div>
      <div className="cowork-item-meta">
        <span>
          {statusLabel[p.status]}
          {p.file_count > 0 ? ` · 파일 ${p.file_count}` : ""}
          {p.chunk_count > 0 ? ` · 청크 ${p.chunk_count.toLocaleString()}` : ""}
        </span>
        {p.status === "ready" ? (
          <span className="cowork-run-badge ok">
            <IconCheckCircle size={11} /> 검색 가능
          </span>
        ) : p.status === "failed" ? (
          <span className="cowork-run-badge failed" title={p.error ?? "실패"}>
            실패
          </span>
        ) : null}
      </div>
    </li>
  );
}


/** One row in the Cowork meetings list. Inline rename (double-click
 *  the name or click ✏) + 회의록 DOCX export modal (📄) + open-
 *  session + delete. The export icon opens a selection dialog so
 *  the user can pick which messages land in the document — raw
 *  transcript is hidden by default. */
function TranscriptRow({
  transcript: t,
  busyId,
  onOpen,
  onDelete,
  onRenamed,
  onExport,
}: {
  transcript: Transcript;
  busyId: string | null;
  onOpen: () => void;
  onDelete: () => void;
  onRenamed: () => void | Promise<void>;
  onExport: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(t.source_filename);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  useEffect(() => {
    if (!editing) setDraft(t.source_filename);
  }, [t.source_filename, editing]);

  async function commit() {
    const next = draft.trim();
    if (!next || next === t.source_filename) {
      setEditing(false);
      setDraft(t.source_filename);
      return;
    }
    setBusy(true);
    try {
      await api.renameTranscript(t.id, next);
      await onRenamed();
      setEditing(false);
    } catch (e) {
      errorToast("이름 변경 실패", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`cowork-item status-${t.status}`}>
      <div className="cowork-item-head">
        {editing ? (
          <input
            ref={inputRef}
            className="cowork-item-name-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
                setDraft(t.source_filename);
              }
            }}
            maxLength={200}
            disabled={busy}
          />
        ) : (
          <span
            className="cowork-item-name"
            title={`${t.source_filename}\n(더블클릭하여 이름 수정)`}
            onDoubleClick={() => setEditing(true)}
          >
            {t.source_filename}
          </span>
        )}
        {!editing && (
          <>
            <button
              type="button"
              className="cowork-item-run"
              onClick={() => setEditing(true)}
              disabled={busy || busyId === t.id}
              title="이름 수정"
            >
              <IconEdit size={11} />
            </button>
            {(t.status === "ok" || t.status === "archived") && t.session_id && (
              <button
                type="button"
                className="cowork-item-run"
                onClick={onExport}
                disabled={busy || busyId === t.id}
                title="회의록 다운로드 (메시지 선택)"
              >
                <IconFileText size={12} />
              </button>
            )}
            <button
              type="button"
              className="cowork-item-run"
              onClick={onDelete}
              disabled={busy || busyId === t.id}
              title={
                t.status === "archived"
                  ? "회의록 완전 삭제 (채팅 세션 포함)"
                  : "전사 기록 삭제 (채팅 세션은 보관됨)"
              }
            >
              <IconX size={13} />
            </button>
          </>
        )}
      </div>
      <div className="cowork-item-meta">
        <span>
          {STATUS_LABEL[t.status]}
          {typeof t.progress === "number" && t.status === "transcribing"
            ? ` ${Math.round(t.progress * 100)}%`
            : ""}
          {t.duration_sec
            ? ` · ${formatDuration(Math.round(t.duration_sec))}`
            : ""}
        </span>
        {(t.status === "ok" || t.status === "archived") && t.session_id ? (
          <button
            type="button"
            className="cowork-run-badge ok"
            onClick={onOpen}
            title={
              t.status === "archived"
                ? "보관된 회의록 열기 (음원은 삭제됨)"
                : "결과 세션 열기 (채팅에서 내용을 수정한 뒤 다시 받으면 반영됩니다)"
            }
          >
            <IconCheckCircle size={11} /> 보기
          </button>
        ) : t.status === "failed" ? (
          <span
            className="cowork-run-badge failed"
            title={t.error ?? "실패"}
          >
            실패
          </span>
        ) : null}
      </div>
    </li>
  );
}


/** Closed-network Whisper bootstrap — checks whether the model is on
 *  disk and exposes a one-click download CTA. Polls while a download
 *  is running so the admin doesn't have to refresh. Shown only when
 *  ENABLE_TRANSCRIPTION is on AND the model isn't already cached. */
function WhisperBootstrapBanner() {
  type Status = Awaited<ReturnType<typeof api.whisperStatus>>;
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setStatus(await api.whisperStatus());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    refresh();
  }, []);
  // Poll every 3s while a download is running so the row updates
  // without the admin having to refresh.
  useEffect(() => {
    if (status?.download.status !== "running") return;
    const id = window.setInterval(refresh, 3000);
    return () => window.clearInterval(id);
  }, [status?.download.status]);

  if (!status || !status.enabled || status.ready) {
    // Transcription disabled OR model already on disk → nothing to show.
    return null;
  }
  const dl = status.download;
  return (
    <div className="whisper-banner">
      <div className="whisper-banner-head">
        <strong>Whisper 모델 준비 필요</strong>
        <span className="whisper-banner-model">{status.model}</span>
      </div>
      {dl.status === "running" ? (
        <div className="whisper-banner-msg">
          ⏳ 다운로드 중… ({dl.model})
          <br />
          <code>{dl.local_dir}</code>
        </div>
      ) : dl.status === "failed" ? (
        <div className="whisper-banner-msg whisper-banner-err">
          ⚠ 실패: {dl.error}
        </div>
      ) : dl.status === "done" ? (
        <div className="whisper-banner-msg">
          ✓ 다운로드 완료. .env 에 다음을 추가하고 백엔드를 재시작하세요:
          <br />
          <code>WHISPER_MODEL={dl.local_dir}</code>
        </div>
      ) : (
        <div className="whisper-banner-msg">
          {status.offline
            ? "오프라인 모드입니다 — 다운로드하려면 일시적으로 TRANSCRIPTION_OFFLINE=false 로 두거나, 인터넷 PC에서 받아서 복사하세요."
            : `백엔드가 ${status.model_dir} 에 다운로드합니다 (약 3 GB, 수 분 소요).`}
        </div>
      )}
      {err && (
        <div className="whisper-banner-msg whisper-banner-err">{err}</div>
      )}
      <div className="whisper-banner-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || dl.status === "running"}
          onClick={async () => {
            setErr(null);
            setBusy(true);
            try {
              await api.whisperDownload();
              await refresh();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {dl.status === "running" ? "다운로드 중…" : "📥 모델 다운로드"}
        </button>
        <button
          type="button"
          className="cowork-upload-btn"
          onClick={refresh}
          disabled={busy}
          title="상태 새로고침"
        >
          ↻
        </button>
      </div>
    </div>
  );
}
