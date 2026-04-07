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
}

export type ChatPhase = "idle" | "streaming" | "error";

export interface StatusStep {
  message: string;
  tool: string;
}
