import type { Session, InstructionInfo, CubeTools, CubeContext } from "@cube/agent";
import { toRuntimeNotice } from "./types.js";
import type { MemoryService } from "./services/memory.service.js";
import type { BackgroundService } from "./services/background.service.js";
import type { ModelService } from "./services/model.service.js";
import type { PreferenceService } from "./services/preference.service.js";
import type { PermissionService } from "./services/permission.service.js";
import type { McpService } from "./services/mcp.service.js";
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
  permission: PermissionService;
  memory: MemoryService;
  background?: BackgroundService;
  mcp?: McpService;
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
  readonly permission: PermissionService;
  readonly memory: MemoryService;
  readonly gateway: GatewayService;
  readonly background?: BackgroundService;
  readonly mcp?: McpService;

  private shutdownPromise?: Promise<void>;
  private unsubscribeTools?: () => void;
  private noticesDelivered = false;

  constructor(private readonly dependencies: CubeRuntimeDependencies) {
    this.prompt = dependencies.prompt;
    this.thread = dependencies.thread;
    this.model = dependencies.model;
    this.preference = dependencies.preference;
    this.permission = dependencies.permission;
    this.memory = dependencies.memory;
    this.gateway = dependencies.gateway;
    this.background = dependencies.background;
    this.mcp = dependencies.mcp;
    if (dependencies.tools) {
      this.unsubscribeTools = dependencies.session.subscribe((event) => {
        if (event.type === "tool_end") dependencies.tools!.discardPreview(event.toolCallId);
        if (
          event.type === "agent_end" &&
          (event.reason === "aborted" ||
            event.reason === "error" ||
            (event.reason === "complete" && !dependencies.session.approval.isArmed()))
        ) {
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
    return this.dependencies.context
      ? { ...state, compacting: this.dependencies.context.isCompacting() }
      : state;
  }

  getInstructionInfo(): InstructionInfo {
    return { ...this.dependencies.readInstructionInfo() };
  }

  subscribe(listener: RuntimeEventListener): () => void {
    const unsubscribe = this.dependencies.session.subscribe((event) =>
      listener(
        event.type === "display_state_changed"
          ? { ...event, displayState: this.getDisplayState() }
          : event,
      ),
    );
    const stopContext = this.dependencies.context?.subscribe((_active, result) => {
      void listener({ type: "display_state_changed", displayState: this.getDisplayState() });
      if (result?.status === "compacted")
        void listener({
          type: "info",
          message: "Context compacted.",
        });
    });
    if (!this.noticesDelivered) {
      this.noticesDelivered = true;
      for (const message of this.dependencies.notices ?? []) listener({ type: "info", message });
    }
    return () => {
      stopContext?.();
      unsubscribe();
    };
  }

  isApprovalPending(): boolean {
    return this.dependencies.session.approval.isArmed();
  }

  interrupt(): boolean {
    if (this.memory.isManual?.()) {
      this.memory.cancel();
      return true;
    }
    if (
      !this.dependencies.session.run.isRunning() &&
      !this.dependencies.session.suspensions.hasPending()
    )
      return false;
    const runId = this.dependencies.session.run.getRunId();
    if (runId) void this.background?.cancelRun(runId).catch(error => this.notify(toRuntimeNotice(error).message));
    this.dependencies.session.abort();
    return true;
  }

  respondToApproval(input: ToolApprovalResponse): void {
    const { tools, session } = this.dependencies;
    if (
      input.decision !== "decline" &&
      tools &&
      ["edit_file", "write_file", "apply_patch"].includes(input.toolName) &&
      !tools.hasPreview(input.toolCallId)
    ) {
      const reason =
        "This file approval has no valid live preview. Request a fresh tool call before approving.";
      session.respondToToolApproval({
        decision: "decline",
        toolCallId: input.toolCallId,
        declineContext: { reason },
      });
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

  notify(message: string): void {
    if (!this.noticesDelivered) (this.dependencies.notices ??= []).push(message);
    else this.dependencies.session.emit({ type: "info", message });
  }

  async cancelSuspension(toolCallId: string): Promise<void> {
    const { session } = this.dependencies;
    const suspension = session.suspensions.get({ toolCallId });
    if (!suspension) return;
    if (suspension.toolName !== "ask_user") {
      this.interrupt();
      return;
    }
    // Resume with a decline so the native loop persists the result and continues.
    session.run.ensureAbortController();
    for (const pending of session.displayState.get().pendingSuspensions.values()) {
      if (pending.toolName === "ask_user" && session.suspensions.has({ toolCallId: pending.toolCallId })) {
        await session.respondToToolSuspension({ toolCallId: pending.toolCallId, resumeData: { cancelled: true } });
      }
    }
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
      if (session.run.isRunning() || session.approval.isArmed() || session.suspensions.hasPending())
        session.abort();
      await this.background?.shutdown();
      if (session.thread.getId() !== null) {
        await session.thread.clearAndReleaseLock().catch(() => undefined);
      }
      await this.dependencies.shutdownResources();
    })();
    return this.shutdownPromise;
  }
}
