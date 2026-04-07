export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
}

export type ChatPhase = "idle" | "streaming" | "error";

export interface StatusStep {
  message: string;
  tool: string;
}
