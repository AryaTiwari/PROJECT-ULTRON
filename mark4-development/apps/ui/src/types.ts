export type ViewMode = "command" | "mission" | "branches" | "operations";

export interface SessionLike {
  id?: string;
  session_id?: string;
  title?: string;
  parent_id?: string | null;
  parent_session_id?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface Mission {
  id: string;
  objective: string;
  status: string;
  state: Record<string, unknown>;
  constraints: Record<string, unknown>;
  completionCriteria: Record<string, unknown>;
  strategy: Record<string, unknown>;
  nextAction?: string | null;
  createdAt: string;
  updatedAt: string;
  evidence?: Array<Record<string, unknown>>;
}

export interface LiveEvent {
  type: string;
  data: Record<string, unknown>;
  at: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}
