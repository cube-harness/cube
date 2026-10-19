import type { AgentControllerDisplayState, AgentControllerEvent, Session } from "@cube/agent";
import type { SubagentTarget } from "./services/subagent.service.js";
import type { SubagentInteraction } from "./services/subagent.service.js";
import type {
  ApiKeyGatewayId,
  GatewayId,
  LocalGatewayId,
  ModelCatalog,
  ReasoningEffort,
} from "@cube/workspace";

export type RuntimeEvent = AgentControllerEvent | SubagentInteraction;
export type RuntimeDisplayState = Readonly<AgentControllerDisplayState> & { compacting?: boolean };
export type RuntimeMessage = Awaited<ReturnType<Session["thread"]["listMessages"]>>[number];

export type RuntimeNotice = {
  level: "info" | "error";
  message: string;
};

export type BackgroundJobRef = { id: string; cursor?: number; limit?: number };
export type BackgroundJobSummary = BackgroundJobRef & {
  title: string; status: string; threadId?: string;
  createdAt: number; completedAt?: number; canStop: boolean;
};
export type BackgroundJobDetail = BackgroundJobSummary & {
  toolName?: string; command?: string; reason?: string; cwd?: string;
  runId?: string; toolCallId?: string; exitCode?: number | null;
  output: string; truncated: boolean;
  ownerDeleted: boolean;
  log_available?: boolean; output_complete?: boolean; next_cursor?: number;
  output_warning?: string;
  read_more?: { tool: "manage_task"; action: "get"; id: string; cursor: number };
};

export const toRuntimeNotice = (error: unknown): RuntimeNotice => {
  let details = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  let message =
    typeof error === "string" ? error : typeof details.message === "string" ? details.message : "";
  // Mastra can put a serialized error object in Error.message.
  if (message.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(message);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        details = { ...details, ...parsed };
        message = typeof parsed.message === "string" ? parsed.message : "";
      }
    } catch {
      /* Not JSON: preserve the original message. */
    }
  }
  const status = details.statusCode ?? details.code;
  if (typeof status === "number" && status >= 100 && status <= 599) {
    if (!message.includes(String(status)))
      message = `HTTP ${status}${message ? `: ${message}` : ""}`;
  } else if (!message && typeof status === "string") {
    message = status;
  }

  // Only display the message, never serialize request bodies, headers or the stack.
  // Redact credentials echoed in provider messages without replacing the error itself.
  message = message
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [Redacted]")
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;}]+)/gi,
      "$1[Redacted]",
    )
    .replace(/\b(?:sk-[\w-]+|AIza[\w-]+)\b/g, "[Redacted]");
  return {
    level: "error",
    message: message.trim() || "Unknown error. Check Cube logs for details.",
  };
};

export type ToolApprovalResponse = {
  target?: SubagentTarget;
  toolCallId: string;
  toolName: string;
  decision: "approve" | "decline" | "approve_prefix";
  declineReason?: string;
};

export type ToolSuspensionResponse = {
  target?: SubagentTarget;
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
  group: "api_key" | "oauth" | "local";
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

export type CredentialGatewayId = Exclude<GatewayId, LocalGatewayId>;
export type GatewayRemovalResult = {
  gatewayId: CredentialGatewayId;
  active: boolean;
  cacheCleared: boolean;
};

export type GatewaySetupRequest = {
  choices: GatewayChoice[];
  current?: GatewayState;
};

export type GatewayPromptResult =
  | { kind: "gateways"; request: GatewaySetupRequest }
  | {
      kind: "models";
      gatewayId: GatewayId;
      catalog: ModelCatalog;
      current: ModelState;
      step?: "model" | "reasoning";
    };

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

export type SubscriptionUsage = {
  provider: string;
  plan?: string;
  notice?: string;
  limits: {
    name: string;
    allowed?: boolean;
    limitReached?: boolean;
    windows: {
      name: string;
      usedPercent?: number;
      remaining?: number;
      unit?: string;
      windowSeconds?: number;
      resetsAt?: number;
    }[];
  }[];
};

export type UsageMetrics = {
  subscription?: SubscriptionUsage;
  model: string;
  reasoningEffort?: string;
  capabilities: string[];
  directory?: string;
  sessionId?: string;
  capabilitiesComplete?: boolean;
  contextLimit?: number;
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

export type PermissionPolicy = "ask" | "allow" | "deny";
export type PermissionState = {
  workspaceOnly: boolean;
  tools: Record<string, PermissionPolicy>;
};

export type PromptResult =
  | { kind: "mcp" }
  | { kind: "tasks" }
  | { kind: "subagents" }
  | { kind: "permissions"; permissions: PermissionState }
  | { kind: "skills"; skills: import("@cube/agent").SkillChoice[] }
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
  | { kind: "usage"; metrics: UsageMetrics; notice?: RuntimeNotice }
  | { kind: "copy-content"; content: string }
  | { kind: "exit-requested" };

export type RuntimeEventListener = (event: RuntimeEvent) => void;
export type { ApiKeyGatewayId, GatewayId, LocalGatewayId, ModelCatalog, ReasoningEffort };
