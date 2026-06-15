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
  /** 답변 생성 지연 (ms) — 어시스턴트 메시지의 응답 시간 표시용. */
  latency_ms?: number | null;
  /** 어시스턴트 출력 토큰 수 — mini 표시용. */
  tokens_out?: number | null;
  /** 자유 태그 (#32) — JSON 직렬화된 string[] 를 백엔드가 list 로
   *  파싱해 보내옴. 빈 / null 둘 다 가능. */
  tags?: string[] | null;
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
  /** 사이드바 상단에 고정한 세션 (#29). */
  pinned?: boolean;
  /** 휴지통 진입 시각 (#31).  null = 정상.  값 있으면 휴지통. */
  deleted_at?: string | null;
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
