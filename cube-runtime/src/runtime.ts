import type { Session, InstructionInfo, CubeTools, CubeContext } from "@cube/agent";
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
  tools?: Pick<CubeTools, "hasPreview" | "discardPreview">;
  notices?: string[];
  prompt: PromptService;
  thread: ThreadService;
  model: ModelService;
  preference: PreferenceService;
  memory: MemoryService;
  context?: CubeContext;
  gateway: GatewayService;
  suggestions: SlashCommandSuggestion[];
  workspaceRoot: string;
  readHistory: () => Promise<string[]>;
  readInstructionInfo: () => InstructionInfo;
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
  private unsubscribeTools?: () => void;
  private noticesDelivered = false;

  constructor(private readonly dependencies: CubeRuntimeDependencies) {
    this.prompt = dependencies.prompt;
    this.thread = dependencies.thread;
    this.model = dependencies.model;
    this.preference = dependencies.preference;
    this.memory = dependencies.memory;
    this.gateway = dependencies.gateway;
    if (dependencies.tools) {
      this.unsubscribeTools = dependencies.session.subscribe((event) => {
        if (event.type === "tool_end") dependencies.tools!.discardPreview(event.toolCallId);
        if (event.type === "agent_end" && (event.reason === "aborted" || event.reason === "error" || (event.reason === "complete" && !dependencies.session.approval.isArmed()))) {
          dependencies.tools!.discardPreview();
        }
      });
    }
  }

  get suggestions(): SlashCommandSuggestion[] {
    return this.dependencies.suggestions.map((suggestion) => ({ ...suggestion }));
  }

  get workspaceRoot(): string {
    return this.dependencies.workspaceRoot;
  }

  getDisplayState(): RuntimeDisplayState {
    const state = this.dependencies.session.displayState.get();
    return this.dependencies.context ? { ...state, compacting: this.dependencies.context.isCompacting() } : state;
  }

  getInstructionInfo(): InstructionInfo {
    return { ...this.dependencies.readInstructionInfo() };
  }

  subscribe(listener: RuntimeEventListener): () => void {
    const unsubscribe = this.dependencies.session.subscribe((event) => listener(event.type === "display_state_changed"
      ? { ...event, displayState: this.getDisplayState() } : event));
    const stopContext = this.dependencies.context?.subscribe((_active, result) => {
      void listener({ type: "display_state_changed", displayState: this.getDisplayState() });
      if (result?.status === "compacted") void listener({ type: "info",
        message: `Context compacted (estimated ${result.before} → ${result.after} tokens).`,
      });
    });
    if (!this.noticesDelivered) {
      this.noticesDelivered = true;
      for (const message of this.dependencies.notices ?? []) listener({ type: "info", message });
    }
    return () => { stopContext?.(); unsubscribe(); };
  }

  isApprovalPending(): boolean {
    return this.dependencies.session.approval.isArmed();
  }

  interrupt(): boolean {
    if (this.memory.isManual?.()) { this.memory.cancel(); return true; }
    if (
      !this.dependencies.session.run.isRunning() &&
      !this.dependencies.session.suspensions.hasPending()
    )
      return false;
    this.dependencies.session.abort();
    return true;
  }

  respondToApproval(input: ToolApprovalResponse): void {
    const { tools, session } = this.dependencies;
    if (input.decision !== "decline" && tools && ["edit_file", "write_file", "apply_patch"].includes(input.toolName) && !tools.hasPreview(input.toolCallId)) {
      const reason = "This file approval has no valid live preview. Request a fresh tool call before approving.";
      session.respondToToolApproval({ decision: "decline", toolCallId: input.toolCallId, declineContext: { reason } });
      tools.discardPreview(input.toolCallId);
      throw new Error(reason);
    }
    if (input.decision === "decline") tools?.discardPreview(input.toolCallId);
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
      this.unsubscribeTools?.();
      this.dependencies.tools?.discardPreview();
      await this.memory.shutdown?.();
      if (session.run.isRunning() || session.approval.isArmed() || session.suspensions.hasPending()) session.abort();
      if (session.thread.getId() !== null) {
        await session.thread.clearAndReleaseLock().catch(() => undefined);
      }
      await this.dependencies.shutdownResources();
    })();
    return this.shutdownPromise;
  }
}
