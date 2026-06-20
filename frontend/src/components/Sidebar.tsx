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
import { CoworkPane } from "./sidebar/CoworkPane";
import { CodePane } from "./sidebar/CodePane";
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


