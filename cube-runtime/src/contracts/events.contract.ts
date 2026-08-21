export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelItem {
  modelId: string;
  name: string;
  provider: string;
  family?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  limit?: { context: number; output: number };
}

export interface ProviderGroup {
  id: string;
  name: string;
  models: ModelItem[];
}

export interface ModelSelectionResult {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id?: string;
  role: MessageRole;
  content: string;
  timestamp?: Date;
  status?: "pending" | "streaming" | "done" | "error";
  toolName?: string;
}

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

export interface SystemInfo {
  model?: string;
  workspace?: string;
  agentMd?: string;
  threadId?: string;
}

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
  isActive: boolean;
}

export interface UsageBoxMetrics {
  title?: string;
  model: string;
  reasoningEffort?: string;
  capabilities?: string[];
  contextLimit: number;
  maxOutput?: number;
  activeTurnTokens?: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  totalTokens: number;
  threadTitle?: string;
  threadId: string;
}

export interface SlashCommandSuggestion {
  name: `/${string}`;
  description: string;
}

// Actions that any UI front-end (TUI, Web, Desktop, VSCode) dispatches to the Runtime
export type CubeAction =
  | { type: "prompt:submit"; content: string }
  | { type: "command:submit"; name: `/${string}`; argument?: string }
  | {
      type: "model:select";
      modelId: string;
      reasoningEffort?: ReasoningEffort;
    }
  | { type: "thread:select"; threadId: string }
  | { type: "theme:select"; themeId: string }
  | { type: "turn:cancel" }
  | { type: "app:exit" };

// Typed Data Events that Runtime emits to subscribers for autonomous rendering
export type CubeEvent =
  | { type: "state:info"; info: SystemInfo }
  | { type: "turn:start"; message?: string }
  | { type: "turn:delta"; text: string }
  | { type: "turn:tool"; tool: DisplayTool }
  | { type: "turn:end" }
  | { type: "message:add"; message: ChatMessage | string }
  | { type: "message:upsert"; message: ChatMessage }
  | { type: "messages:set"; messages: ChatMessage[] }
  | { type: "messages:clear" }
  | {
      type: "dialog:model_picker";
      providers: ProviderGroup[];
      currentModelId?: string;
      currentReasoningEffort?: ReasoningEffort;
    }
  | { type: "dialog:thread_picker"; threads: ThreadSummary[] }
  | { type: "dialog:theme"; currentThemeId?: string }
  | { type: "usage:metrics"; metrics: UsageBoxMetrics }
  | { type: "system:message"; content: string }
  | { type: "system:error"; error: string };

export type CubeEventListener = (event: CubeEvent) => void;
