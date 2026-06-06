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
  created_at: string;
  updated_at: string;
}

export interface SessionDetail extends Session {
  messages: Message[];
}
