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
  /** When true, the chat panel renders this message as a collapsed
   *  "원문 전사 — 펼치기" placeholder. Set by the transcription
   *  pipeline so the raw whisper output doesn't flood the bubble row. */
  hidden?: boolean;
  /** 즐겨찾기 토글 — 별표 한 메시지를 다른 세션 가리지 않고 한 곳에 모음. */
  starred?: boolean;
  /** 답변 평가: 1 (👍) / -1 (👎) / 0 (미평가). */
  feedback?: number;
  /** 평가에 덧붙인 자유 메모. 500자 한도. */
  feedback_note?: string | null;
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
