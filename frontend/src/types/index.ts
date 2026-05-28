export type Mode = "single" | "compare";

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
  created_at: string;
}

export interface Session {
  id: string;
  title: string;
  mode: Mode;
  created_at: string;
  updated_at: string;
}

export interface SessionDetail extends Session {
  messages: Message[];
}
