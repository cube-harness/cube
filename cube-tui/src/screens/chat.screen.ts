import type { Component, TUI } from "@earendil-works/pi-tui";
import type {
  ModelCatalog,
  ModelSelection,
  ModelState,
  RuntimeDisplayState,
  RuntimeNotice,
  SlashCommandSuggestion,
  ThreadSnapshot,
  ThreadSummary,
  UsageMetrics,
} from "@cube/runtime";
import { ApprovalPicker, type ToolApprovalDecision } from "../components/approval-picker.js";
import {
  ToolSuspensionPicker,
  type ToolSuspensionRequest,
  type ToolSuspensionResolution,
} from "../components/tool-suspension-picker.js";
import { Banner } from "../components/banner.js";
import { Footer } from "../components/footer.js";
import { InfoBox, type InfoBoxContent } from "../components/info-box.js";
import { MessageList } from "../components/message-list.js";
import { ModelPickerComponent } from "../components/model-picker.js";
import { PromptEditor } from "../components/prompt-editor.js";
import { StatusLinePickerComponent } from "../components/statusline-picker.js";
import { ThemePickerOverlay } from "../components/theme-picker.js";
import { ThreadPickerOverlay } from "../components/thread-picker.js";
import { TitlePickerComponent } from "../components/title-picker.js";
import { renderUsageBoxToString } from "../components/usage-box.js";
import { WorkingIndicator } from "../components/working-indicator.js";

export type ChatScreenOptions = {
  tui: TUI;
  basePath: string;
  slashCommands?: SlashCommandSuggestion[];
  initialHistory?: string[];
  statusLine?: string[];
  initialInfo?: InfoBoxContent;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const inspectReasoning = (
  message: RuntimeDisplayState["currentMessage"],
  streaming: boolean,
): { present: boolean; complete: boolean } => {
  const parts =
    message?.content && typeof message.content === "object" && "parts" in message.content
      ? message.content.parts
      : [];
  if (!Array.isArray(parts)) return { present: false, complete: false };

  const reasoningIndex = parts.findIndex((part) => {
    const record = asRecord(part);
    return record?.type === "reasoning";
  });
  if (reasoningIndex < 0) return { present: false, complete: false };
  const hasFollowingOutput = parts.slice(reasoningIndex + 1).some((part) => {
    const record = asRecord(part);
    if (record?.type === "tool-invocation") return true;
    return (
      record?.type === "text" && typeof record.text === "string" && record.text.trim().length > 0
    );
  });
  return { present: true, complete: !streaming || hasFollowingOutput };
};

export class ChatScreen {
  readonly banner: Banner;
  readonly infoBox: InfoBox;
  readonly messageList: MessageList;
  readonly workingIndicator: WorkingIndicator;
  readonly promptEditor: PromptEditor;
  readonly footer: Footer;

  private mounted = false;
  private onSubmit?: (content: string) => void | Promise<void>;
  private reasoningTiming?: {
    messageId: string;
    startedAt: number;
    durationMs?: number;
  };
  private activeSuspensionOverlay?: {
    toolCallId: string;
    dismiss: () => void;
  };

  constructor(private readonly options: ChatScreenOptions) {
    this.banner = new Banner();
    this.infoBox = new InfoBox(undefined, options.initialInfo);
    this.messageList = new MessageList();
    this.workingIndicator = new WorkingIndicator(options.tui);
    this.promptEditor = new PromptEditor({
      tui: options.tui,
      basePath: options.basePath,
      slashCommands: options.slashCommands,
      initialHistory: options.initialHistory,
      onSubmit: (content) => this.onSubmit?.(content),
    });
    this.footer = new Footer(options.initialInfo, options.statusLine);
  }

  mount(handlers: { onSubmit(content: string): void | Promise<void> }): void {
    this.onSubmit = handlers.onSubmit;
    if (this.mounted) return;
    this.mounted = true;
    this.options.tui.addChild(this.banner);
    this.options.tui.addChild(this.infoBox);
    this.options.tui.addChild(this.messageList);
    this.options.tui.addChild(this.workingIndicator);
    this.options.tui.addChild(this.promptEditor);
    this.options.tui.addChild(this.footer);
    this.options.tui.setFocus(this.promptEditor);
  }

  unmount(): void {
    this.promptEditor.focused = false;
    this.workingIndicator.stop();
    if (!this.mounted) return;
    this.mounted = false;
    this.options.tui.removeChild(this.footer);
    this.options.tui.removeChild(this.promptEditor);
    this.options.tui.removeChild(this.workingIndicator);
    this.options.tui.removeChild(this.messageList);
    this.options.tui.removeChild(this.infoBox);
    this.options.tui.removeChild(this.banner);
  }

  requestRender(): void {
    this.options.tui.requestRender();
  }

  startTerminal(): void {
    this.options.tui.start();
  }

  stopTerminal(): void {
    this.unmount();
    this.options.tui.stop();
  }

  addInputListener(listener: Parameters<TUI["addInputListener"]>[0]): () => void {
    return this.options.tui.addInputListener(listener);
  }

  renderDisplayState(state: RuntimeDisplayState, approvalPending: boolean): void {
    const reasoning = inspectReasoning(state.currentMessage, state.isRunning);
    let reasoningDurationMs: number | undefined;
    if (reasoning.present && state.currentMessage) {
      const messageId = state.currentMessage.id ?? "current-reasoning";
      if (!this.reasoningTiming || this.reasoningTiming.messageId !== messageId) {
        this.reasoningTiming = { messageId, startedAt: Date.now() };
      }
      if (reasoning.complete && this.reasoningTiming.durationMs === undefined) {
        this.reasoningTiming.durationMs = Math.max(0, Date.now() - this.reasoningTiming.startedAt);
      }
      reasoningDurationMs = this.reasoningTiming.durationMs;
    }
    if (state.currentMessage) {
      if (reasoningDurationMs && reasoningDurationMs > 0) {
        this.messageList.applySessionMessage(
          state.currentMessage,
          state.isRunning,
          reasoningDurationMs,
        );
      } else {
        this.messageList.applySessionMessage(state.currentMessage, state.isRunning);
      }
    }
    if (!state.isRunning && !reasoning.present) this.reasoningTiming = undefined;
    const indicator = this.workingIndicator.sync(state, approvalPending);
    this.promptEditor.setCursorBlinking(!indicator.spinning);
    this.footer.setStatus(state.isRunning ? "Busy" : "Idle");
    this.requestRender();
  }

  showThread(snapshot: ThreadSnapshot): void {
    this.reasoningTiming = undefined;
    this.messageList.setSessionMessages(snapshot.messages);
    this.setInfo({
      threadTitle: snapshot.title,
      threadId: snapshot.threadId,
    });
    this.requestRender();
  }

  addUserMessage(content: string): void {
    this.messageList.addMessage({ role: "user", content, status: "done" });
    this.requestRender();
  }

  showNotice(notice: RuntimeNotice): void {
    this.messageList.addMessage({
      role: "system",
      content: notice.message,
      status: notice.level === "error" ? "error" : "done",
    });
    this.requestRender();
  }

  showUsage(metrics: UsageMetrics): void {
    this.messageList.addMessage({
      role: "system",
      content: renderUsageBoxToString(metrics),
      status: "done",
    });
    this.requestRender();
  }

  setInfo(info: InfoBoxContent): void {
    this.infoBox.setInfo(info);
    this.footer.setInfo(info);
  }

  setStatusLine(statusLine: string[]): void {
    this.footer.setStatusLine(statusLine);
    this.requestRender();
  }

  clearConversation(): void {
    this.reasoningTiming = undefined;
    this.messageList.clearMessages();
    this.promptEditor.clearQueuedPrompts();
    this.setInfo({
      threadTitle: undefined,
      threadId: "new thread",
    });
    this.requestRender();
  }

  pickThread(threads: ThreadSummary[]): Promise<string | null> {
    return this.showOverlay<string | null>(
      (finish) =>
        new ThreadPickerOverlay({
          threads,
          onSelect: finish,
          onCancel: () => finish(null),
        }),
    );
  }

  pickModel(catalog: ModelCatalog, current: ModelState): Promise<ModelSelection | null> {
    const providers = Object.entries(catalog.providers).map(([id, provider]) => ({
      id,
      name: provider.name,
      models: provider.models,
    }));
    return this.showOverlay<ModelSelection | null>(
      (finish) =>
        new ModelPickerComponent({
          providers,
          currentModelId: current.modelId,
          currentReasoningEffort: current.reasoningEffort,
          onSelect: finish,
          onCancel: () => finish(null),
        }),
    );
  }

  pickTheme(current: string): Promise<string | null> {
    return this.showOverlay<string | null>(
      (finish) =>
        new ThemePickerOverlay({
          currentThemeId: current,
          onSelect: finish,
          onCancel: () => finish(null),
        }),
    );
  }

  pickTitle(current: string[]): Promise<string[] | null> {
    return this.showOverlay<string[] | null>(
      (finish) =>
        new TitlePickerComponent({
          initialSelection: current,
          currentValues: {
            model: this.infoBox.getModel(),
            workspace: this.infoBox.getWorkspace(),
            threadTitle: this.infoBox.getThreadTitle(),
            threadId: this.infoBox.getThreadId(),
            status: this.footer.getStatus(),
          },
          onSelect: finish,
          onCancel: () => finish(null),
        }),
    );
  }

  pickStatusLine(current: string[]): Promise<string[] | null> {
    return this.showOverlay<string[] | null>(
      (finish) =>
        new StatusLinePickerComponent({
          initialSelection: current,
          currentValues: {
            model: this.infoBox.getModel(),
            workspace: this.infoBox.getWorkspace(),
            agentMd: this.infoBox.getAgentMd(),
            threadTitle: this.infoBox.getThreadTitle(),
            threadId: this.infoBox.getThreadId(),
            status: this.footer.getStatus(),
          },
          onSelect: finish,
          onCancel: () => finish(null),
        }),
    );
  }

  requestApproval(input: { toolName: string; args: unknown }): Promise<ToolApprovalDecision> {
    return this.showOverlay<ToolApprovalDecision>(
      (finish) =>
        new ApprovalPicker({
          toolName: input.toolName,
          args: input.args,
          onDecision: finish,
        }),
    );
  }

  requestToolSuspension(request: ToolSuspensionRequest): Promise<ToolSuspensionResolution> {
    return this.showOverlay<ToolSuspensionResolution>(
      (finish) => new ToolSuspensionPicker({ request, onResolve: finish }),
      (finish) => {
        this.activeSuspensionOverlay = {
          toolCallId: request.toolCallId,
          dismiss: () => finish({ kind: "dismissed" }),
        };
      },
      () => {
        if (this.activeSuspensionOverlay?.toolCallId === request.toolCallId) {
          this.activeSuspensionOverlay = undefined;
        }
      },
    );
  }

  cancelToolSuspension(toolCallId: string): void {
    if (this.activeSuspensionOverlay?.toolCallId !== toolCallId) return;
    this.activeSuspensionOverlay.dismiss();
  }

  private showOverlay<T>(
    create: (finish: (value: T) => void) => Component,
    onOpen?: (finish: (value: T) => void) => void,
    onClose?: () => void,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      let closed = false;
      let overlay: Component;
      const finish = (value: T): void => {
        if (closed) return;
        closed = true;
        this.options.tui.removeChild(this.footer);
        this.options.tui.removeChild(overlay);
        this.options.tui.addChild(this.promptEditor);
        this.options.tui.addChild(this.footer);
        this.options.tui.setFocus(this.promptEditor);
        this.requestRender();
        onClose?.();
        resolve(value);
      };

      overlay = create(finish);
      onOpen?.(finish);
      this.options.tui.removeChild(this.footer);
      this.options.tui.removeChild(this.promptEditor);
      this.options.tui.addChild(overlay);
      this.options.tui.addChild(this.footer);
      this.options.tui.setFocus(overlay);
      this.requestRender();
    });
  }
}
