import {
  toRuntimeNotice,
  type CubeRuntime,
  type CubeBootstrap,
  type ModelState,
  type PreferenceState,
  type PromptResult,
  type RuntimeDisplayState,
  type RuntimeEvent,
} from "@cube/runtime";
import { copyToClipboard } from "./clipboard.js";
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
  private activeApprovalId: string | null = null;
  private readonly activeSuspensionIds = new Set<string>();
  private readonly cancelledSuspensionIds = new Set<string>();
  private suspensionInputQueue: Promise<void> = Promise.resolve();
  private suspensionQueueCancelled = false;
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
    this.unsubscribeInput = this.screen.addInputListener((data) => {
      if (matchesBinding(data, "cube.transcript.toggle")) {
        this.screen.messageList.toggleTranscript();
        this.screen.requestRender();
        return { consume: true };
      }
      if (matchesBinding(data, "cube.app.exit")) {
        void this.handleExit();
        return { consume: true };
      }
      if (matchesBinding(data, "cube.turn.interrupt")) {
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
    this.applyPreferences(this.preferences);
    if (!options.screenAlreadyMounted) this.screen.startTerminal();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.unsubscribeRuntime();
    this.unsubscribeRuntime = () => undefined;
    this.unsubscribeInput();
    this.unsubscribeInput = () => undefined;
    this.runtime.interrupt();
    this.screen.stopTerminal();
  }

  async submitPrompt(content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;
    const state = this.runtime.getDisplayState();
    const isSlashCommand = trimmed.startsWith("/");
    if (!isSlashCommand) {
      if (state.isRunning || (state.queuedFollowUps ?? 0) > 0) {
        this.screen.promptEditor.enqueueQueuedPrompt(trimmed);
        this.screen.requestRender();
      } else {
        this.screen.addUserMessage(trimmed);
      }
    }

    try {
      await this.handlePromptResult(await this.runtime.prompt.submit(trimmed));
    } catch (error: unknown) {
      this.screen.workingIndicator.stop();
      this.screen.showNotice(toRuntimeNotice(error));
    }
  }

  async handlePromptResult(result: PromptResult): Promise<void> {
    switch (result.kind) {
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
        return;
      case "command-catalog":
        this.screen.showNotice({
          level: "info",
          message: [
            "### Available Slash Commands",
            "",
            ...result.commands.map((command) => `- \`${command.name}\`: ${command.description}`),
          ].join("\n"),
        });
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
        if (this.activeApprovalId === event.toolCallId) return;
        this.activeApprovalId = event.toolCallId;
        void this.screen
          .requestApproval({ toolName: event.toolName, args: event.args })
          .then((decision) => {
            this.runtime.respondToApproval({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              decision,
              ...(decision === "decline" ? { declineReason: "User declined tool execution." } : {}),
            });
            this.applyDisplayState(this.runtime.getDisplayState());
          })
          .finally(() => {
            this.activeApprovalId = null;
          });
        return;
      case "tool_suspended":
        if (this.activeSuspensionIds.has(event.toolCallId)) return;
        if (this.activeSuspensionIds.size === 0) this.suspensionQueueCancelled = false;
        this.activeSuspensionIds.add(event.toolCallId);
        this.suspensionInputQueue = this.suspensionInputQueue.then(async () => {
          try {
            if (this.suspensionQueueCancelled || this.cancelledSuspensionIds.has(event.toolCallId))
              return;
            const resolution = await this.screen.requestToolSuspension({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
              suspendPayload: event.suspendPayload,
              ...(event.resumeSchema ? { resumeSchema: event.resumeSchema } : {}),
            });
            if (resolution.kind === "dismissed") return;
            if (resolution.kind === "cancel") {
              this.suspensionQueueCancelled = true;
              this.runtime.interrupt();
              return;
            }
            await this.runtime.respondToSuspension({
              toolCallId: event.toolCallId,
              resumeData: resolution.resumeData,
            });
          } catch (error: unknown) {
            this.screen.workingIndicator.stop();
            this.screen.showNotice(toRuntimeNotice(error));
          } finally {
            this.activeSuspensionIds.delete(event.toolCallId);
            this.cancelledSuspensionIds.delete(event.toolCallId);
            this.applyDisplayState(this.runtime.getDisplayState());
            if (this.activeSuspensionIds.size === 0) this.suspensionQueueCancelled = false;
          }
        });
        return;
      case "tool_suspension_cancelled":
        this.cancelledSuspensionIds.add(event.toolCallId);
        this.screen.cancelToolSuspension(event.toolCallId);
        return;
      case "thread_created":
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
        this.screen.setInfo({
          threadId: event.threadId,
        });
        this.screen.promptEditor.clearQueuedPrompts();
        this.nativeQueuedFollowUps = 0;
        this.locallyCancelledQueueTransitions = 0;
        this.updateTerminalTitle();
        return;
      case "error":
        this.screen.workingIndicator.stop();
        this.screen.showNotice(toRuntimeNotice(event.error));
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

  handleInterrupt(): boolean {
    const queued = this.screen.promptEditor.popQueuedPrompt();
    if (queued !== undefined) {
      const nativeQueued = this.runtime.prompt.cancelLatestQueued();
      if (nativeQueued === null) {
        this.screen.promptEditor.enqueueQueuedPrompt(queued);
      } else {
        this.locallyCancelledQueueTransitions += 1;
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
    "mount" | "stopTerminal" | "showNotice" | "pickGateway" | "waitForRetry"
  >,
): Promise<PreparedCube | null> => {
  while (true) {
    let runtime: CubeRuntime | undefined;
    try {
      const bootstrap = await prepare();
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
