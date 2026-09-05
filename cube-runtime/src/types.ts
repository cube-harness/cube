import type { AgentControllerDisplayState, AgentControllerEvent, Session } from "@cube/agent";
import type {
  ApiKeyGatewayId,
  GatewayId,
  LocalGatewayId,
  ModelCatalog,
  ReasoningEffort,
} from "@cube/workspace";

export type RuntimeEvent = AgentControllerEvent;
export type RuntimeDisplayState = Readonly<AgentControllerDisplayState>;
export type RuntimeMessage = Awaited<ReturnType<Session["thread"]["listMessages"]>>[number];

export type RuntimeNotice = {
  level: "info" | "error";
  message: string;
};

export const toRuntimeNotice = (error: unknown): RuntimeNotice => {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b429\b|quota|rate.?limit|token limit|insufficient_quota/i.test(message)) {
    return {
      level: "error",
      message: "Quota or token limit reached. Run /gateway or /model to continue.",
    };
  }
  if (/\b40[13]\b|unauthor|forbidden|credential|api key|authentication|authorization|oauth|sign.?in/i.test(message)) {
    return {
      level: "error",
      message: "Authentication failed. Run /gateway to sign in or replace the credential.",
    };
  }
  if (/unknown model|invalid model|model .*not available|catalog/i.test(message)) {
    return {
      level: "error",
      message: "Model unavailable. Run /model or /gateway to choose another model.",
    };
  }
  if (/config|failed to save|failed to write|gateway switch failed/i.test(message)) {
    return {
      level: "error",
      message: "Could not save Cube configuration. The previous configuration is still active.",
    };
  }
  if (/timeout|timed out|network|unavailable|offline|econn|fetch failed/i.test(message)) {
    return {
      level: "error",
      message: "Gateway unavailable. Check the connection or run /gateway.",
    };
  }
  return {
    level: "error",
    message: "Something went wrong. Check Cube logs for details.",
  };
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

export type GatewayChoice = {
  gatewayId: GatewayId;
  group: "api_key" | "subscription" | "local";
  provider: string;
  configured: boolean;
};

export type GatewayDraft = {
  draftId: string;
  gatewayId: GatewayId;
  catalog: ModelCatalog;
  currentModelId?: string;
};

export type GatewaySelection = {
  draftId: string;
  model: ModelSelection;
};

export type GatewayState = {
  gatewayId: GatewayId;
  model: ModelState;
};

export type GatewaySetupRequest = {
  choices: GatewayChoice[];
  current?: GatewayState;
};

export type GatewayPromptResult =
  | { kind: "gateways"; request: GatewaySetupRequest }
  | { kind: "models"; gatewayId: GatewayId; catalog: ModelCatalog; current: ModelState };

export type GatewayReadiness =
  | { ready: true; gatewayId: GatewayId; model: ModelState }
  | { ready: false; reason: string; configuredGateway?: GatewayId };

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
  | GatewayPromptResult
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
export type {
  ApiKeyGatewayId,
  GatewayId,
  LocalGatewayId,
  ModelCatalog,
  ReasoningEffort,
};
