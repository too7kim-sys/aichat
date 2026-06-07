import type { AttachmentSummary } from "../api/client";

export interface ProviderInfo {
  name: string;
  label: string;
  model: string;
  enabled: boolean;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  provider: string | null;
  content: string;
  attachments_summary: AttachmentSummary[] | null;
  created_at: string;
}

export interface Session {
  id: string;
  title: string;
  workspace_id: string | null;
  code_focused: boolean;
  /** Optional chat-project (folder) id. null = sits in the default
   *  ungrouped bucket on the sidebar. */
  chat_project_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Sidebar folder grouping related chat sessions, distinct from the
 *  RAG `Project` (knowledge base) — purely organisational + carries
 *  an optional system prompt the chat router prepends on every turn
 *  for member sessions. */
export interface ChatProject {
  id: string;
  name: string;
  description: string;
  instructions: string;
  session_count: number;
  created_at: string;
  updated_at: string;
}

export interface SessionDetail extends Session {
  messages: Message[];
}
