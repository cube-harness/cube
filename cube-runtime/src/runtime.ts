import type { Session } from "@cube/agent";
import type { MemoryService } from "./services/memory.service.js";
import type { ModelService } from "./services/model.service.js";
import type { PreferenceService } from "./services/preference.service.js";
import type { PromptService } from "./services/prompt.service.js";
import type { ThreadService } from "./services/thread.service.js";
import type { GatewayService } from "./services/gateway.service.js";
import type {
  RuntimeDisplayState,
  RuntimeEventListener,
  SlashCommandSuggestion,
  ToolApprovalResponse,
  ToolSuspensionResponse,
} from "./types.js";

type CubeRuntimeDependencies = {
  session: Session;
  prompt: PromptService;
  thread: ThreadService;
  model: ModelService;
  preference: PreferenceService;
  memory: MemoryService;
  gateway: GatewayService;
  suggestions: SlashCommandSuggestion[];
  workspaceRoot: string;
  readHistory: () => Promise<string[]>;
  shutdownResources: () => Promise<void>;
};

export class CubeRuntime {
  readonly prompt: PromptService;
  readonly thread: ThreadService;
  readonly model: ModelService;
  readonly preference: PreferenceService;
  readonly memory: MemoryService;
  readonly gateway: GatewayService;

  private shutdownPromise?: Promise<void>;

  constructor(private readonly dependencies: CubeRuntimeDependencies) {
    this.prompt = dependencies.prompt;
    this.thread = dependencies.thread;
    this.model = dependencies.model;
    this.preference = dependencies.preference;
    this.memory = dependencies.memory;
    this.gateway = dependencies.gateway;
  }

  get suggestions(): SlashCommandSuggestion[] {
    return this.dependencies.suggestions.map((suggestion) => ({ ...suggestion }));
  }

  get workspaceRoot(): string {
    return this.dependencies.workspaceRoot;
  }

  getDisplayState(): RuntimeDisplayState {
    return this.dependencies.session.displayState.get();
  }

  subscribe(listener: RuntimeEventListener): () => void {
    return this.dependencies.session.subscribe(listener);
  }

  isApprovalPending(): boolean {
    return this.dependencies.session.approval.isArmed();
  }

  interrupt(): boolean {
    if (
      !this.dependencies.session.run.isRunning() &&
      !this.dependencies.session.suspensions.hasPending()
    )
      return false;
    this.dependencies.session.abort();
    return true;
  }

  respondToApproval(input: ToolApprovalResponse): void {
    if (input.decision === "approve_prefix") {
      this.dependencies.session.grantTool(input.toolName);
    }
    this.dependencies.session.respondToToolApproval({
      decision: input.decision === "decline" ? "decline" : "approve",
      toolCallId: input.toolCallId,
      ...(input.decision === "decline" && input.declineReason
        ? { declineContext: { reason: input.declineReason } }
        : {}),
    });
  }

  respondToSuspension(input: ToolSuspensionResponse): Promise<void> {
    return this.dependencies.session.respondToToolSuspension(input);
  }

  getHistory(): Promise<string[]> {
    return this.dependencies.readHistory();
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      const session = this.dependencies.session;
      if (session.run.isRunning()) session.abort();
      if (session.thread.getId() !== null) {
        await session.thread.clearAndReleaseLock().catch(() => undefined);
      }
      await this.dependencies.shutdownResources();
    })();
    return this.shutdownPromise;
  }
}
