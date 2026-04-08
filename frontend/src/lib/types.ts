export type ChatRole = "user" | "assistant";

export interface Citation {
  index: number;
  title: string;
  url: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  citations?: Citation[];
  animateOnMount?: boolean;
  /** True when the user aborted the SSE stream; UI shows a short status line. */
  generationStopped?: boolean;
}

export interface ChatSessionSummary {
  session_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServerChatMessage {
  id: string;
  role: string;
  content: string | null;
  created_at: string;
  citations?: Citation[];
}

export type ChatPhase = "idle" | "streaming" | "error";

export interface StatusStep {
  message: string;
  tool: string;
  stage?: string;
  toolDisplay?: string;
  agent?: string;
}
