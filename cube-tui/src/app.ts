import {
  toRuntimeNotice,
  type CubeRuntime,
  type CubeBootstrap,
  type ModelState,
  type PreferenceState,
  type PromptResult,
  type RuntimeDisplayState,
  type RuntimeEvent,
  type SubagentTarget,
} from "@cube/runtime";
import { copyToClipboard } from "./clipboard.js";
import { matchesKey } from "@earendil-works/pi-tui";
import { matchesBinding } from "./keybindings.js";
import type { ChatScreen } from "./screens/chat.screen.js";
import type { OnBoardScreen } from "./screens/on-board.screen.js";
import { formatTerminalTitle } from "./components/title-picker.js";
import { setSyntaxTheme } from "./themes/syntax.theme.js";

export type CubeAppOptions = {
  copyToClipboard?: (content: string) => Promise<boolean>;
  onExitRequested: () => void | Promise<void>;
};

export type CubeAppStartOptions = {
  screenAlreadyMounted?: boolean;
};

export type PreparedCube = {
  app: CubeApp;
  runtime: CubeRuntime;
};

export class CubeApp {
  private unsubscribeRuntime: () => void = () => undefined;
  private unsubscribeInput: () => void = () => undefined;
  private unsubscribeActivities: () => void = () => undefined;
  private readonly interactions = new Map<string, SubagentTarget | undefined>();
  private readonly cancelledInteractions = new Set<string>();
  private readonly questions = new Set<string>();
  private interactionQueue: Promise<void> = Promise.resolve();
  private nativeQueuedFollowUps: number;
  private locallyCancelledQueueTransitions = 0;
  private currentModel: ModelState;
  private preferences: PreferenceState;
  private started = false;

  constructor(
    private readonly runtime: CubeRuntime,
    private readonly screen: ChatScreen,
    private readonly options: CubeAppOptions,
  ) {
    this.nativeQueuedFollowUps = runtime.getDisplayState().queuedFollowUps ?? 0;
    this.currentModel = runtime.model.current();
    this.preferences = runtime.preference.get();
    this.screen.setSkillProvider(async () => {
      try { return await this.runtime.preference.listSkills(); }
      catch (error) { this.screen.showNotice(toRuntimeNotice(error)); return []; }
    });
  }

  async start(options: CubeAppStartOptions = {}): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (options.screenAlreadyMounted) {
      this.screen.setSubmitHandler((content) => this.submitPrompt(content));
    } else {
      this.screen.mount({ onSubmit: (content) => this.submitPrompt(content) });
    }
    this.unsubscribeRuntime = this.runtime.subscribe((event) => this.handleRuntimeEvent(event));
    const stopBackground = this.runtime.background?.subscribe(() => this.syncActivityCounts());
    const stopSubagents = this.runtime.subagents?.subscribe(() => this.syncActivityCounts());
    this.unsubscribeActivities = () => { stopBackground?.(); stopSubagents?.(); };
    this.syncActivityCounts();
    this.unsubscribeInput = this.screen.addInputListener((data) => {
      if (matchesBinding(data, "cube.transcript.toggle")) {
        this.screen.messageList.toggleTranscript();
        this.screen.requestRender();
        return { consume: true };
      }
      if (matchesBinding(data, "cube.subagent.approvals") && this.screen.reviewSubagentApprovals()) {
        return { consume: true };
      }
      if (matchesBinding(data, "cube.app.exit")) {
        void this.handleExit();
        return { consume: true };
      }
      if (matchesBinding(data, "cube.turn.interrupt")) {
        if (matchesKey(data, "escape")) {
          if (!this.screen.promptEditor.focused || this.screen.promptEditor.isShowingAutocomplete()) {
            return undefined;
          }
          if (this.screen.scrollToBottom()) return { consume: true };
        }
        return this.handleInterrupt() ? { consume: true } : undefined;
      }
      return undefined;
    });
    this.screen.renderDisplayState(
      this.runtime.getDisplayState(),
      this.runtime.isApprovalPending(),
    );
    this.screen.setInfo({
      model: this.formatModel(this.currentModel),
      workspace: this.runtime.workspaceRoot,
      threadId: this.runtime.thread.current() ?? "new thread",
    });
    this.syncInstructionInfo();
    this.applyPreferences(this.preferences);
    if (!options.screenAlreadyMounted) this.screen.startTerminal();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const key of this.interactions.keys()) this.cancelInteraction(key);
    this.unsubscribeRuntime();
    this.unsubscribeRuntime = () => undefined;
    this.unsubscribeInput();
    this.unsubscribeInput = () => undefined;
    this.unsubscribeActivities();
    this.unsubscribeActivities = () => undefined;
    this.runtime.interrupt();
    this.screen.stopTerminal();
  }

  async submitPrompt(content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;
    try {
      await this.handlePromptResult(await this.runtime.prompt.submit(trimmed, (queued) => {
        if (queued) {
          this.screen.promptEditor.enqueueQueuedPrompt(trimmed);
          this.screen.requestRender();
        } else {
          this.screen.addUserMessage(trimmed);
        }
      }));
    } catch (error: unknown) {
      this.screen.workingIndicator.stop();
      this.screen.showNotice(toRuntimeNotice(error));
    } finally {
      this.syncInstructionInfo();
      this.screen.requestRender();
    }
  }

  private syncInstructionInfo(): void {
    const info = this.runtime.getInstructionInfo();
    const number = (value: number) => value.toLocaleString("en-US");
    this.screen.setInfo({
      soul: `Loaded · ${number(info.soulCharacters)} chars`,
      agentMd: info.agentsFiles
        ? `Loaded · ${number(info.agentsFiles)} ${info.agentsFiles === 1 ? "file" : "files"} · ${number(info.agentsCharacters)} chars`
        : "None",
    });
  }

  async handlePromptResult(result: PromptResult): Promise<void> {
    switch (result.kind) {
      case "mcp":
        if (this.runtime.mcp) await this.screen.pickMcp(this.runtime.mcp);
        return;
      case "tasks":
        if (this.runtime.background) await this.screen.pickTasks(this.runtime.background);
        return;
      case "subagents": {
        const parent = this.runtime.thread.current();
        if (this.runtime.subagents) await this.screen.pickSubagents(this.runtime.subagents, parent ?? "new thread");
        return;
      }
      case "skills":
        await this.screen.pickSkills(result.skills, (changes) => this.runtime.preference.setSkillsEnabled(changes));
        return;
      case "permissions":
        await this.screen.pickPermissions(result.permissions, (state) => this.runtime.permission.set(state));
        return;
      case "ignored":
      case "submitted":
        return;
      case "notice":
        if (result.notice.level === "error") this.screen.workingIndicator.stop();
        this.screen.showNotice(result.notice);
        return;
      case "models": {
        const selection = await this.screen.pickModel(
          result.gatewayId,
          result.catalog,
          result.current,
          result.step,
        );
        if (selection) {
          await this.handlePromptResult({
            kind: "model",
            model: await this.runtime.model.set(selection),
          });
        }
        return;
      }
      case "gateways": {
        const selection = await this.screen.pickGateway(this.runtime.gateway, result.request);
        if (!selection) return;
        const state = await this.runtime.gateway.set(selection);
        await this.handlePromptResult({ kind: "model", model: state.model });
        return;
      }
      case "model":
        this.currentModel = result.model;
        this.screen.setInfo({ model: this.formatModel(result.model) });
        this.updateTerminalTitle();
        return;
      case "threads": {
        const threadId = await this.screen.pickThread(result.threads);
        if (!threadId) return;
        if (result.operation === "resume") {
          this.screen.showThread(await this.runtime.thread.resume(threadId));
        } else {
          const deleted = await this.runtime.thread.delete(threadId);
          if (deleted.wasActive) this.screen.clearConversation();
          else {
            this.screen.showNotice({
              level: "info",
              message: `Deleted thread: ${threadId}`,
            });
          }
        }
        return;
      }
      case "thread":
        this.screen.showThread(result.snapshot);
        return;
      case "thread-reset":
        this.screen.clearConversation();
        return;
      case "preferences": {
        const request = result.request;
        if (request.target === "theme") {
          const theme = await this.screen.pickTheme(request.current);
          if (theme) {
            await this.handlePromptResult({
              kind: "preference",
              preference: await this.runtime.preference.setTheme(theme),
            });
          }
        } else if (request.target === "title") {
          const title = await this.screen.pickTitle(request.current);
          if (title?.length) {
            await this.handlePromptResult({
              kind: "preference",
              preference: await this.runtime.preference.setTitle(title),
            });
          }
        } else {
          const statusLine = await this.screen.pickStatusLine(request.current);
          if (statusLine?.length) {
            await this.handlePromptResult({
              kind: "preference",
              preference: await this.runtime.preference.setStatusLine(statusLine),
            });
          }
        }
        return;
      }
      case "preference":
        this.preferences = result.preference;
        this.applyPreferences(result.preference);
        return;
      case "usage":
        this.screen.showUsage(result.metrics);
        if (result.notice) this.screen.showNotice(result.notice);
        return;
      case "copy-content": {
        const copied = await (this.options.copyToClipboard ?? copyToClipboard)(result.content);
        this.screen.showNotice({
          level: copied ? "info" : "error",
          message: copied
            ? "Copied last response to clipboard as markdown."
            : "Failed to copy response to clipboard.",
        });
        return;
      }
      case "exit-requested":
        await this.options.onExitRequested();
    }
  }

  handleRuntimeEvent(event: RuntimeEvent): void {
    switch (event.type) {
      case "display_state_changed":
        this.applyDisplayState(event.displayState);
        return;
      case "tool_approval_required":
        this.queueInteraction(event);
        return;
      case "tool_suspended":
        this.queueInteraction(event);
        return;
      case "tool_suspension_cancelled":
        this.cancelInteraction(`main:${event.toolCallId}`);
        return;
      case "subagent_interaction":
        this.queueInteraction(event.event, event.target,
          event.event.type === "tool_approval_required" ? event.agent : `${event.description} · ${event.agent}`,
          event.directory, event.description);
        return;
      case "subagent_interaction_cancelled":
        for (const [key, target] of this.interactions) if (target?.jobId === event.jobId &&
          (!event.runId || target.runId === event.runId)) this.cancelInteraction(key);
        return;
      case "agent_end":
        if (event.reason !== "suspended") for (const [key, target] of this.interactions)
          if (!target) this.cancelInteraction(key);
        return;
      case "thread_created":
        this.syncActivityCounts();
        this.screen.setInfo({
          threadId: event.thread.id,
          threadTitle: event.thread.title,
        });
        this.updateTerminalTitle();
        return;
      case "thread_title_updated":
        this.screen.setInfo({
          threadId: (event as { threadId: string }).threadId,
          threadTitle: (event as { title?: string }).title,
        });
        this.updateTerminalTitle();
        return;
      case "thread_changed":
        this.syncActivityCounts();
        this.screen.setInfo({
          threadId: event.threadId,
        });
        this.screen.promptEditor.clearQueuedPrompts();
        this.nativeQueuedFollowUps = 0;
        this.locallyCancelledQueueTransitions = 0;
        this.updateTerminalTitle();
        return;
      case "thread_deleted":
        this.syncActivityCounts();
        if (!this.runtime.thread.current()) {
          this.screen.setInfo({ threadId: "new thread", threadTitle: undefined });
          this.updateTerminalTitle();
        }
        return;
      case "error":
        this.screen.workingIndicator.stop();
        this.screen.showNotice(toRuntimeNotice(event.error));
        return;
      case "info":
        this.screen.showNotice({ level: "info", message: event.message });
        return;
      case "workspace_status_changed":
        if (String(event.status) !== "ready") {
          this.screen.workingIndicator.start(`Workspace: ${String(event.status)}`);
        }
        return;
      case "workspace_ready":
        this.screen.workingIndicator.stop();
        return;
      case "workspace_error":
        this.screen.workingIndicator.stop();
        this.screen.showNotice(toRuntimeNotice(event.error));
    }
  }

  private cancelInteraction(key: string): void {
    if (this.interactions.get(key) && !this.questions.has(key)) {
      this.interactions.delete(key);
      this.screen.removeSubagentApproval(key);
      return;
    }
    this.cancelledInteractions.add(key);
    this.screen.cancelToolSuspension(key);
    this.screen.cancelApproval(key);
  }

  private syncActivityCounts(): void {
    this.screen.setActivityCounts(
      this.runtime.background?.runningCount() ?? 0,
      this.runtime.subagents?.runningCount() ?? 0,
    );
  }

  private queueInteraction(
    event: Extract<RuntimeEvent, { type: "tool_approval_required" | "tool_suspended" }>,
    target?: SubagentTarget,
    label?: string,
    directory?: string,
    description?: string,
  ): void {
    const key = target ? `${target.jobId}:${target.runId}:${event.toolCallId}` : `main:${event.toolCallId}`;
    if (this.interactions.has(key)) return;
    this.interactions.set(key, target);
    if (target && event.type === "tool_approval_required") {
      this.screen.addSubagentApproval({
        id: key, agent: label ?? "Subagent", description, toolName: event.toolName, args: event.args, directory,
        onDecision: decision => {
          if (!this.started || !this.interactions.has(key)) return;
          this.interactions.delete(key);
          this.screen.removeSubagentApproval(key);
          try {
            this.runtime.respondToApproval({ target, toolName: event.toolName, toolCallId: event.toolCallId, decision,
              ...(decision === "decline" ? { declineReason: "User declined tool execution." } : {}) });
          } catch (error) { this.screen.showNotice(toRuntimeNotice(error)); }
          this.applyDisplayState(this.runtime.getDisplayState());
        },
      });
      return;
    }
    if (event.type === "tool_suspended") this.questions.add(key);
    this.interactionQueue = this.interactionQueue.then(async () => {
      try {
        if (this.cancelledInteractions.has(key) || !this.started) return;
        if (event.type === "tool_approval_required") {
          const decision = await this.screen.requestApproval({ toolName: event.toolName, args: event.args, label, directory, interactionId: key });
          if (this.cancelledInteractions.has(key)) return;
          this.runtime.respondToApproval({ target, toolName: event.toolName, toolCallId: event.toolCallId, decision,
            ...(decision === "decline" ? { declineReason: "User declined tool execution." } : {}) });
        } else {
          const resolution = await this.screen.requestToolSuspension({ ...event, toolCallId: key, label });
          if (resolution.kind === "dismissed" || this.cancelledInteractions.has(key)) return;
          if (resolution.kind === "cancel") {
            // Never cancel a sibling's identical tool-call ID.
            for (const [other, owner] of this.interactions) if (owner?.jobId === target?.jobId && this.questions.has(other)) this.cancelInteraction(other);
            void this.runtime.cancelSuspension(event.toolCallId, target).catch(error => this.screen.showNotice(toRuntimeNotice(error)));
          } else void this.runtime.respondToSuspension({ target, toolCallId: event.toolCallId, resumeData: resolution.resumeData })
            .catch(error => this.screen.showNotice(toRuntimeNotice(error)));
        }
      } catch (error) { this.screen.showNotice(toRuntimeNotice(error)); }
      finally {
        this.interactions.delete(key); this.cancelledInteractions.delete(key);
        this.questions.delete(key);
        this.applyDisplayState(this.runtime.getDisplayState());
      }
    });
  }

  handleInterrupt(): boolean {
    const queued = this.screen.promptEditor.popQueuedPrompt();
    if (queued !== undefined) {
      this.locallyCancelledQueueTransitions += 1;
      const nativeQueued = this.runtime.prompt.cancelLatestQueued();
      if (nativeQueued === null) {
        this.locallyCancelledQueueTransitions -= 1;
        this.screen.promptEditor.enqueueQueuedPrompt(queued);
      }
      this.screen.requestRender();
      return true;
    }

    const state = this.runtime.getDisplayState();
    if (this.runtime.isApprovalPending() || state.pendingSuspensions.size > 0) {
      return false;
    }
    return this.runtime.interrupt();
  }

  async handleExit(): Promise<void> {
    if (this.handleInterrupt()) return;
    const state = this.runtime.getDisplayState();
    if (
      this.runtime.isApprovalPending() ||
      state.pendingSuspensions.size > 0 ||
      this.screen.workingIndicator.isActive()
    ) {
      return;
    }
    await this.options.onExitRequested();
  }

  private applyDisplayState(state: RuntimeDisplayState): void {
    this.syncInstructionInfo();
    const nextQueued = state.queuedFollowUps ?? 0;
    if (nextQueued < this.nativeQueuedFollowUps) {
      let removed = this.nativeQueuedFollowUps - nextQueued;
      const locallyCancelled = Math.min(removed, this.locallyCancelledQueueTransitions);
      this.locallyCancelledQueueTransitions -= locallyCancelled;
      removed -= locallyCancelled;
      for (const content of this.screen.promptEditor.dequeueQueuedPrompts(removed)) {
        this.screen.addUserMessage(content);
      }
    }
    this.nativeQueuedFollowUps = nextQueued;
    this.screen.renderDisplayState(state, this.runtime.isApprovalPending());
  }

  private applyPreferences(preference: PreferenceState): void {
    setSyntaxTheme(preference.theme);
    this.screen.setStatusLine(preference.statusLine);
    this.updateTerminalTitle(preference.appTitle);
  }

  private updateTerminalTitle(fields: string[] = this.preferences.appTitle): void {
    const state = this.runtime.getDisplayState();
    const title = formatTerminalTitle(fields, {
      model: this.formatModel(this.currentModel),
      workspace: this.runtime.workspaceRoot,
      threadTitle: this.screen.infoBox?.getThreadTitle?.(),
      threadId: this.runtime.thread.current() ?? "new thread",
      status: state.isRunning ? "Busy" : "Idle",
    });
    try {
      if (process.stdout.isTTY) process.stdout.write(`\x1b]0;${title}\x07\x1b]2;${title}\x07`);
      process.title = title;
    } catch {
      // Terminal title updates are best effort.
    }
  }

  private formatModel(model: ModelState): string {
    return `${model.modelId}${
      model.reasoningEffort && model.reasoningEffort !== "none" ? ` (${model.reasoningEffort})` : ""
    }`;
  }
}

export const startPreparedCube = async (
  prepare: () => Promise<CubeBootstrap>,
  createScreen: (bootstrap: CubeBootstrap) => ChatScreen,
  options: CubeAppOptions,
  onboarding: Pick<
    OnBoardScreen,
    "mount" | "stopTerminal" | "showNotice" | "pickTrust" | "pickGateway" | "waitForRetry"
  >,
): Promise<PreparedCube | null> => {
  while (true) {
    let runtime: CubeRuntime | undefined;
    try {
      const bootstrap = await prepare();
      if (!bootstrap.permission?.trusted) {
        const trusted = await onboarding.pickTrust(bootstrap.workspaceRoot);
        if (!trusted) {
          onboarding.stopTerminal();
          return null;
        }
        await bootstrap.setTrust(true);
      }
      if (!bootstrap.readiness.ready) {
        onboarding.mount();
        const selection = await onboarding.pickGateway(bootstrap.gateway);
        if (!selection) {
          onboarding.stopTerminal();
          return null;
        }
        await bootstrap.gateway.commitInitial(selection);
      }
      runtime = await bootstrap.start();
      onboarding.stopTerminal();
      const screen = createScreen(bootstrap);
      const app = new CubeApp(runtime, screen, options);
      try {
        await app.start();
      } catch (error) {
        await app.stop();
        throw error;
      }
      return { app, runtime };
    } catch (error) {
      await runtime?.shutdown().catch(() => undefined);
      onboarding.mount();
      onboarding.showNotice(toRuntimeNotice(error));
      if (!(await onboarding.waitForRetry())) {
        onboarding.stopTerminal();
        return null;
      }
    }
  }
};
