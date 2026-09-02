import type {
  AgentControllerDisplayState,
  AgentControllerEvent,
  Session,
} from "@cube/agent";
import type { ModelCatalog, ReasoningEffort } from "@cube/workspace";

export type RuntimeEvent = AgentControllerEvent;
export type RuntimeDisplayState = Readonly<AgentControllerDisplayState>;
export type RuntimeMessage = Awaited<
  ReturnType<Session["thread"]["listMessages"]>
>[number];

export type RuntimeNotice = {
  level: "info" | "error";
  message: string;
};

export type ToolApprovalResponse = {
  toolCallId: string;
  toolName: string;
  decision: "approve" | "decline" | "approve_prefix";
  declineReason?: string;
};

export type ToolSuspensionResponse = {
  toolCallId: string;
  resumeData: unknown;
};

export type ModelSelection = {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
};

export type ModelState = ModelSelection;

export type ThreadSummary = {
  id: string;
  title: string;
  updatedAt: string;
  isActive: boolean;
};

export type ThreadSnapshot = {
  threadId: string;
  title: string;
  messages: RuntimeMessage[];
};

export type PreferenceState = {
  theme: string;
  appTitle: string[];
  statusLine: string[];
};

export type UsageMetrics = {
  model: string;
  reasoningEffort?: string;
  capabilities: string[];
  directory?: string;
  sessionId?: string;
  contextLimit: number;
  maxOutput?: number;
  activeTurnTokens?: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  threadTitle?: string;
  threadId: string;
};

export type PreferenceRequest =
  | { target: "theme"; current: string }
  | { target: "title"; current: string[] }
  | { target: "statusLine"; current: string[] };

export type SlashCommandSuggestion = {
  name: `/${string}`;
  description: string;
};

export type PromptResult =
  | { kind: "ignored" }
  | { kind: "submitted" }
  | { kind: "notice"; notice: RuntimeNotice }
  | { kind: "models"; catalog: ModelCatalog; current: ModelState }
  | { kind: "model"; model: ModelState }
  | {
      kind: "threads";
      operation: "resume" | "delete";
      threads: ThreadSummary[];
    }
  | { kind: "thread"; snapshot: ThreadSnapshot }
  | { kind: "thread-reset" }
  | { kind: "preferences"; request: PreferenceRequest }
  | { kind: "preference"; preference: PreferenceState }
  | { kind: "usage"; metrics: UsageMetrics }
  | { kind: "command-catalog"; commands: SlashCommandSuggestion[] }
  | { kind: "copy-content"; content: string }
  | { kind: "exit-requested" };

export type RuntimeEventListener = (event: RuntimeEvent) => void;
export type { ModelCatalog, ReasoningEffort };
