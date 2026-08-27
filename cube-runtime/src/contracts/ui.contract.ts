export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default";

export interface ModelItem {
  modelId: string;
  name: string;
  family?: string;
  reasoning?: boolean;
  reasoning_efforts?: string[];
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
  tool?: DisplayTool;
}

export interface DisplayTool {
  id: string;
  name: string;
  args: unknown;
  status: "streaming_input" | "waiting_approval" | "running" | "completed" | "error" | "declined";
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

/** Commands a Cube UI sends to the shared runtime. Native Session operations stay on Session. */
export type CubeUIAction =
  | { type: "prompt:submit"; content: string }
  | { type: "command:submit"; name: `/${string}`; argument?: string }
  | {
      type: "model:select";
      modelId: string;
      reasoningEffort?: ReasoningEffort;
    }
  | { type: "thread:select"; threadId: string }
  | { type: "theme:select"; themeId: string }
  | { type: "title:select"; appTitle: string[] }
  | { type: "statusline:select"; statusLine: string[] }
  | { type: "app:exit" };

/** Cube-specific UI notifications. Agent lifecycle and transcript use native Session events. */
export type CubeUIEvent =
  | { type: "state:info"; info: SystemInfo }
  | { type: "activity:start"; id: string; message: string }
  | { type: "activity:end"; id: string }
  | { type: "messages:clear" }
  | {
      type: "dialog:model_picker";
      providers: ProviderGroup[];
      currentModelId?: string;
      currentReasoningEffort?: ReasoningEffort;
    }
  | { type: "dialog:thread_picker"; threads: ThreadSummary[] }
  | { type: "dialog:theme"; currentThemeId?: string }
  | { type: "dialog:title_picker"; currentAppTitle?: string[] }
  | { type: "dialog:statusline_picker"; currentStatusLine?: string[] }
  | { type: "usage:metrics"; metrics: UsageBoxMetrics }
  | { type: "system:message"; content: string }
  | { type: "system:error"; error: string };

export type CubeUIEventListener = (event: CubeUIEvent) => void;
