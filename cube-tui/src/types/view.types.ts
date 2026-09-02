export type MessageRole = "user" | "assistant" | "system" | "tool" | "reasoning";

export interface DisplayTool {
  id: string;
  name: string;
  args: unknown;
  status:
    | "streaming_input"
    | "waiting_approval"
    | "running"
    | "completed"
    | "error"
    | "declined";
  partialResult?: string;
  result?: unknown;
  shellOutput?: string;
}

export interface ChatMessage {
  id?: string;
  role: MessageRole;
  content: string;
  transcriptContent?: string;
  timestamp?: Date;
  status?: "pending" | "streaming" | "done" | "error";
  toolName?: string;
  tool?: DisplayTool;
  sourceMessageId?: string;
}

export interface SystemInfo {
  model?: string;
  workspace?: string;
  agentMd?: string;
  threadId?: string;
}
