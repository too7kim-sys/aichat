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
import { ChatPane } from "./sidebar/ChatPane";
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

// Cowork hosts the shared prompt library + workflow automation. RAG
// project management moved to the admin "지식베이스" panel; Cowork
// is now where users browse prompts and schedule workflow runs.
const TABS: { id: Workspace; label: string; icon: import("react").ReactNode }[] = [
  { id: "chat", label: "Chat", icon: <IconChat size={18} /> },
  { id: "cowork", label: "Cowork", icon: <IconUsers size={18} /> },
  { id: "code", label: "Code", icon: <IconCode size={18} /> },
];

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

