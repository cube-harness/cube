import {
  HStack, ScrollView, VStack, isViewportTUI, truncateToWidth, visibleWidth,
  type Component, type TUI,
} from "@earendil-works/pi-tui";
import type {
  GatewayId,
  GatewaySelection,
  GatewaySetupRequest,
  ModelCatalog,
  ModelSelection,
  ModelState,
  RuntimeDisplayState,
  RuntimeNotice,
  SlashCommandSuggestion,
  ThreadSnapshot,
  ThreadSummary,
  UsageMetrics,
  SkillChoice,
  PermissionState,
  BackgroundService,
  McpService,
  SubagentService,
} from "@cube/runtime";
import { toRuntimeNotice } from "@cube/runtime";
import { SkillPicker } from "../components/skill-picker.js";
import { PermissionPicker } from "../components/permission-picker.js";
import { TaskPicker } from "../components/task-picker.js";
import { SubagentPicker } from "../components/subagent-picker.js";
import { McpPicker } from "../components/mcp-picker.js";
import { ApprovalPicker, type ToolApprovalDecision } from "../components/approval-picker.js";
import { SubagentApprovalPicker, type SubagentApprovalRequest } from "../components/subagent-approval-picker.js";
import { formatBinding } from "../keybindings.js";
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
import { GatewaySetupComponent, type GatewaySetupOptions } from "../components/gateway-picker.js";
import { PromptEditor } from "../components/prompt-editor.js";
import { Card } from "../components/card.js";
import { StatusLinePickerComponent } from "../components/statusline-picker.js";
import { ThemePickerOverlay } from "../components/theme-picker.js";
import { ThreadPickerOverlay } from "../components/thread-picker.js";
import { TitlePickerComponent } from "../components/title-picker.js";
import { renderUsageBoxToString } from "../components/usage-box.js";
import { WorkingIndicator } from "../components/working-indicator.js";
import { PetPanel } from "../components/pet.js";
import { appTheme } from "../themes/app.theme.js";

export type ChatScreenOptions = {
  tui: TUI;
  basePath: string;
  slashCommands?: SlashCommandSuggestion[];
  initialHistory?: string[];
  statusLine?: string[];
  initialInfo?: InfoBoxContent;
  getSkills?: () => Promise<SkillChoice[]>;
  petCacheDir?: string;
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
  private closeTasks?: () => void;
  private closeMcp?: () => void;
  private closeSubagents?: () => void;
  private activeApprovalOverlay?: { key: string; dismiss(): void };
  private readonly subagentApprovals = new Map<string, SubagentApprovalRequest>();
  private subagentApprovalPicker?: SubagentApprovalPicker;
  private closeSubagentReview?: () => void;
  private subagentReviewClosed?: Promise<void>;
  private readonly subagentApprovalHint: Component = {
    invalidate: () => {},
    render: width => {
      const count = new Set([...this.subagentApprovals.keys()].map(id => id.split(":")[0])).size;
      return count ? [truncateToWidth(appTheme.ui.primary(
        `${count} ${count === 1 ? "subagent needs" : "subagents need"} approval · ${formatBinding("cube.subagent.approvals")} to review`,
      ), width, "")] : [];
    },
  };
  private dock?: VStack;
  private inputPanel?: PetPanel;
  private transcript?: ScrollView;
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
      getSkills: () => this.options.getSkills?.() ?? Promise.resolve([]),
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
    this.options.tui.addChild(this.subagentApprovalHint);
    this.options.tui.addChild(this.promptEditor);
    this.options.tui.addChild(this.footer);
    if (isViewportTUI(this.options.tui)) {
      this.inputPanel = new PetPanel(
        this.options.tui, this.options.petCacheDir,
        () => this.promptEditor.getText(),
        () => this.inputPanel?.children.includes(this.promptEditor) ? this.promptEditor.getCardStartRow() : 0,
      );
      this.inputPanel.addChild(this.promptEditor);
      this.dock = new VStack([
        { component: this.subagentApprovalHint, shrink: 0, visible: () => this.subagentApprovals.size > 0 },
        this.inputPanel, { component: this.footer, shrink: 0 },
      ]);
      void this.inputPanel.start();
      this.transcript = new ScrollView(this.messageList, { follow: "end", primary: true });
      const backToBottom: Component = {
        invalidate: () => {},
        render: (width) => {
          const text = truncateToWidth(" ⭣ Back to bottom · Esc ", width, "");
          const space = Math.max(0, width - visibleWidth(text));
          const left = Math.floor(space / 2);
          return [" ".repeat(left) + appTheme.ui.primary.bgHex(appTheme.surface.background)(text)];
        },
      };
      const welcome: Component = {
        invalidate: () => { this.banner.invalidate(); this.infoBox.invalidate(); },
        render: (width) => [this.banner, this.infoBox].flatMap((component) => {
          const lines = component.render(width).map((line) => truncateToWidth(line, width, ""));
          const contentWidth = Math.max(0, ...lines.map(visibleWidth));
          const padding = " ".repeat(Math.max(0, Math.floor((width - contentWidth) / 2)));
          return lines.map((line) => padding + line);
        }),
      };
      const empty = () => this.messageList.getMessages().length === 0;
      this.options.tui.setLayoutRoot(new VStack([
        { component: new HStack([{ component: welcome, grow: 1 }], { align: "center" }),
          basis: 0, grow: 1, visible: empty },
        { component: this.transcript, basis: 0, grow: 1, visible: () => !empty() },
        { component: this.workingIndicator, shrink: 0 },
        { component: backToBottom, shrink: 0, visible: () => this.canReturnToBottom() },
        { component: this.dock, minSize: 2 },
      ]));
    }
    this.options.tui.setFocus(this.promptEditor);
  }

  setSubmitHandler(onSubmit: (content: string) => void | Promise<void>): void {
    this.onSubmit = onSubmit;
  }

  unmount(): void {
    this.closeTasks?.();
    this.closeMcp?.();
    this.closeSubagents?.();
    this.closeSubagentReview?.();
    this.subagentApprovals.clear();
    this.promptEditor.focused = false;
    this.inputPanel?.stop();
    this.workingIndicator.stop();
    if (!this.mounted) return;
    this.mounted = false;
    if (isViewportTUI(this.options.tui)) this.options.tui.setLayoutRoot(undefined);
    this.dock = undefined;
    this.inputPanel = undefined;
    this.transcript = undefined;
    this.options.tui.removeChild(this.footer);
    this.options.tui.removeChild(this.promptEditor);
    this.options.tui.removeChild(this.workingIndicator);
    this.options.tui.removeChild(this.subagentApprovalHint);
    this.options.tui.removeChild(this.messageList);
    this.options.tui.removeChild(this.infoBox);
    this.options.tui.removeChild(this.banner);
  }

  requestRender(): void {
    this.options.tui.requestRender();
  }

  setActivityCounts(background: number, subagents: number): void {
    this.footer.setActivityCounts(background, subagents);
    this.requestRender();
  }

  private canReturnToBottom(): boolean {
    return this.promptEditor.focused && !this.promptEditor.isShowingAutocomplete()
      && this.transcript !== undefined && !this.transcript.isFollowingEnd;
  }

  scrollToBottom(): boolean {
    if (!this.canReturnToBottom()) return false;
    this.transcript!.scrollToEnd();
    this.requestRender();
    return true;
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
      this.messageList.applySessionMessage(
        state.currentMessage,
        state.isRunning,
        reasoningDurationMs,
        state.pendingApproval,
      );
    }
    if (!state.isRunning && !reasoning.present) this.reasoningTiming = undefined;
    const indicator = this.workingIndicator.sync(state, approvalPending);
    this.inputPanel?.sync(indicator);
    this.promptEditor.setCursorBlinking(!indicator.spinning);
    this.footer.setStatus(state.isRunning ? "Busy" : "Idle");
    this.requestRender();
  }

  showThread(snapshot: ThreadSnapshot): void {
    this.reasoningTiming = undefined;
    this.messageList.setSessionMessages(snapshot.messages);
    this.transcript?.scrollToEnd();
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
    if (info.threadId !== undefined && info.threadId !== this.infoBox.getThreadId()) this.closeSubagents?.();
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
    this.transcript?.scrollToEnd();
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

  pickModel(
    gatewayId: GatewayId,
    catalog: ModelCatalog,
    current: ModelState,
    initialStep?: "model" | "reasoning",
  ): Promise<ModelSelection | null> {
    return this.showOverlay<ModelSelection | null>(
      (finish) =>
        new ModelPickerComponent({
          gatewayId,
          catalog,
          currentModelId: current.modelId,
          currentReasoningEffort: current.reasoningEffort,
          initialStep,
          onSelect: finish,
          onCancel: () => finish(null),
        }),
    );
  }

  pickGateway(
    gateway: GatewaySetupOptions["gateway"],
    request: GatewaySetupRequest,
  ): Promise<GatewaySelection | null> {
    return this.showOverlay<GatewaySelection | null | Error>(
      (finish) =>
        new GatewaySetupComponent({
          onNotice: (notice) => this.showNotice(notice),
          tui: this.options.tui,
          gateway,
          request,
          onSelect: finish,
          onCancel: () => finish(null),
          onError: (error) => finish(error instanceof Error ? error : new Error(String(error))),
        }),
    ).then((result) => {
      if (result instanceof Error) throw result;
      return result;
    });
  }

  setSkillProvider(getSkills: () => Promise<SkillChoice[]>): void {
    this.options.getSkills = getSkills;
  }

  pickSkills(items: SkillChoice[], onApply: (changes: Pick<SkillChoice, "path" | "enabled">[]) => Promise<void>): Promise<void> {
    return this.showOverlay<void>((finish) => new SkillPicker(items, {
      onApply, onCancel: () => finish(), onChange: () => this.requestRender(),
      onError: (error) => this.showNotice(toRuntimeNotice(error)),
    }));
  }

  pickPermissions(state: PermissionState, onApply: (state: PermissionState) => Promise<void>): Promise<void> {
    return this.showOverlay<void>((finish) => new PermissionPicker(state, {
      onApply, onCancel: () => finish(), onChange: () => this.requestRender(),
      onError: (error) => this.showNotice(toRuntimeNotice(error)),
    }));
  }

  pickTasks(background: BackgroundService): Promise<void> {
    let picker: TaskPicker;
    return this.showOverlay<void>(finish => (picker = new TaskPicker(background, {
      onClose: () => finish(), onChange: () => this.requestRender(),
      onError: error => this.showNotice(toRuntimeNotice(error)),
      logHeight: () => Math.max(3, this.options.tui.terminal.rows - 20),
    })), finish => { this.closeTasks = () => finish(); }, () => {
      picker.dispose(); this.closeTasks = undefined;
    });
  }

  pickMcp(service: McpService): Promise<void> {
    let picker: McpPicker;
    return this.showOverlay<void>(finish => (picker = new McpPicker(service, {
      tui: this.options.tui, onClose: () => finish(), onChange: () => this.requestRender(),
    })), finish => { this.closeMcp = () => finish(); }, () => {
      picker.dispose(); this.closeMcp = undefined;
    });
  }

  pickSubagents(service: SubagentService, parentThreadId: string): Promise<void> {
    let picker: SubagentPicker;
    return this.showOverlay<void>(finish => (picker = new SubagentPicker(service,
      { projectRoot: this.infoBox.getWorkspace(), parentThreadId }, {
        onClose: () => finish(), onChange: () => this.requestRender(),
        onError: error => this.showNotice(toRuntimeNotice(error)),
        height: () => Math.max(3, this.options.tui.terminal.rows - 18),
      })), finish => { this.closeSubagents = () => finish(); }, () => {
        picker.dispose(); this.closeSubagents = undefined;
      });
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

  addSubagentApproval(request: SubagentApprovalRequest): void {
    this.subagentApprovals.set(request.id, request);
    this.subagentApprovalPicker?.setRequests([...this.subagentApprovals.values()]);
    this.requestRender();
  }

  removeSubagentApproval(id: string): void {
    if (!this.subagentApprovals.delete(id)) return;
    if (!this.subagentApprovals.size) this.closeSubagentReview?.();
    else this.subagentApprovalPicker?.setRequests([...this.subagentApprovals.values()]);
    this.requestRender();
  }

  reviewSubagentApprovals(): boolean {
    if (this.closeSubagentReview) {
      this.closeSubagentReview();
      return true;
    }
    if (!this.subagentApprovals.size || !this.promptEditor.focused
      || this.promptEditor.isShowingAutocomplete() || this.activeApprovalOverlay || this.activeSuspensionOverlay) return false;
    this.subagentReviewClosed = this.showOverlay<void>(
      finish => (this.subagentApprovalPicker = new SubagentApprovalPicker(
        [...this.subagentApprovals.values()], () => finish(),
      )),
      finish => { this.closeSubagentReview = () => finish(); },
      () => {
        this.subagentApprovalPicker = undefined;
        this.closeSubagentReview = undefined;
        this.subagentReviewClosed = undefined;
      },
    );
    return true;
  }

  async requestApproval(input: { toolName: string; args: unknown; label?: string; directory?: string; interactionId?: string }): Promise<ToolApprovalDecision> {
    // Keep a review already in focus until the user closes it; cancellation still wins.
    if (this.subagentReviewClosed) {
      let cancelled = false;
      this.activeApprovalOverlay = { key: input.interactionId ?? input.toolName, dismiss: () => { cancelled = true; } };
      await this.subagentReviewClosed;
      this.activeApprovalOverlay = undefined;
      if (cancelled) return "decline";
    }
    this.closeSubagents?.();
    return this.showOverlay<ToolApprovalDecision>(
      (finish) =>
        new ApprovalPicker({
          toolName: input.toolName,
          args: input.args,
          label: input.label,
          directory: input.directory ?? this.infoBox.getWorkspace(),
          onDecision: finish,
        }),
      finish => { this.activeApprovalOverlay = { key: input.interactionId ?? input.toolName, dismiss: () => finish("decline") }; },
      () => { this.activeApprovalOverlay = undefined; },
    );
  }

  requestToolSuspension(request: ToolSuspensionRequest): Promise<ToolSuspensionResolution> {
    this.closeSubagents?.();
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

  cancelApproval(key: string): void {
    if (this.activeApprovalOverlay?.key === key) this.activeApprovalOverlay.dismiss();
  }

  private showOverlay<T>(
    create: (finish: (value: T) => void) => Component,
    onOpen?: (finish: (value: T) => void) => void,
    onClose?: () => void,
  ): Promise<T> {
    this.closeTasks?.();
    this.closeMcp?.();
    this.closeSubagents?.();
    this.closeSubagentReview?.();
    return new Promise<T>((resolve) => {
      const host = this.inputPanel ?? this.dock ?? this.options.tui;
      let closed = false;
      let overlay: Component;
      const finish = (value: T): void => {
        if (closed) return;
        closed = true;
        host.removeChild(this.footer);
        host.removeChild(overlay);
        host.addChild(this.promptEditor);
        if (host !== this.inputPanel) host.addChild(this.footer);
        this.options.tui.setFocus(this.promptEditor);
        this.requestRender();
        onClose?.();
        resolve(value);
      };

      overlay = new Card(create(finish));
      onOpen?.(finish);
      host.removeChild(this.footer);
      host.removeChild(this.promptEditor);
      host.addChild(overlay);
      if (host !== this.inputPanel) host.addChild(this.footer);
      this.options.tui.setFocus(overlay);
      this.requestRender();
    });
  }
}
