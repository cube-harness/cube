import chalk from "chalk";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";
import { formatBinding } from "../keybindings.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const renderShimmerText = (text: string, frameIndex: number): string => {
  if (!text) return "";
  const len = text.length;
  const cycle = len + 6;
  const wavePos = (frameIndex % cycle) - 2;

  let result = "";
  for (let i = 0; i < len; i++) {
    const char = text[i];
    const dist = Math.abs(i - wavePos);
    if (dist === 0) {
      result += appTheme.ui.text.bold(char);
    } else if (dist === 1) {
      result += appTheme.ui.text(char);
    } else {
      result += appTheme.ui.muted(char);
    }
  }
  return result;
};

export type WorkingPhase =
  | "idle"
  | "thinking"
  | "streaming"
  | "tool"
  | "approval"
  | "input"
  | "subagent"
  | "memory";

export interface WorkingIndicatorState {
  visible: boolean;
  spinning: boolean;
  phase: WorkingPhase;
  message: string;
}

interface SessionDisplayStateLike {
  compacting?: boolean;
  isRunning: boolean;
  currentMessage: null | {
    content?: { parts?: unknown[] };
  };
  activeTools: Map<string, { name: string; status: string }>;
  pendingApproval: { toolName?: string } | null;
  pendingSuspensions: Map<string, unknown>;
  activeSubagents: Map<string, { agentType: string; displayName?: string; status: string }>;
  omProgress: { status: string };
  bufferingMessages: boolean;
  bufferingObservations: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const deriveWorkingIndicatorState = (
  state: SessionDisplayStateLike,
  approvalPending: boolean,
): WorkingIndicatorState => {
  if (approvalPending && state.pendingApproval) {
    const suffix = state.pendingApproval.toolName ? `: ${state.pendingApproval.toolName}` : "";
    return {
      visible: true,
      spinning: true,
      phase: "approval",
      message: `Waiting for approval${suffix}`,
    };
  }
  if (state.pendingSuspensions.size > 0) {
    return { visible: true, spinning: true, phase: "input", message: "Waiting for input" };
  }

  const activeTool = Array.from(state.activeTools.values()).find(
    (tool) => tool.status === "running" || tool.status === "streaming_input",
  );
  if (activeTool) {
    return {
      visible: true,
      spinning: true,
      phase: "tool",
      message: `${activeTool.status === "streaming_input" ? "Preparing" : "Running"} ${activeTool.name}`,
    };
  }

  const activeSubagent = Array.from(state.activeSubagents.values()).find(
    (subagent) => subagent.status === "running",
  );
  if (activeSubagent) {
    return {
      visible: true,
      spinning: true,
      phase: "subagent",
      message: `Running ${activeSubagent.displayName || activeSubagent.agentType}`,
    };
  }

  if (state.compacting) {
    return { visible: true, spinning: true, phase: "memory", message: "Compacting" };
  }

  if (!state.isRunning) {
    return { visible: false, spinning: false, phase: "idle", message: "Idle" };
  }

  const parts = state.currentMessage?.content?.parts ?? [];
  const hasText = parts.some(
    (part) =>
      isRecord(part) &&
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.length > 0,
  );
  if (hasText) {
    return { visible: true, spinning: true, phase: "streaming", message: "Responding" };
  }
  const hasReasoning = parts.some((part) => isRecord(part) && part.type === "reasoning");
  if (hasReasoning) {
    return { visible: true, spinning: true, phase: "thinking", message: "Thinking" };
  }

  return { visible: true, spinning: true, phase: "thinking", message: "Working" };
};

export interface WorkingIndicatorOptions {
  now?: () => number;
  schedule?: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  cancelSchedule?: (timer: NodeJS.Timeout) => void;
  spinnerStyle?: (text: string) => string;
  messageStyle?: (text: string) => string;
  timerStyle?: (text: string) => string;
}

export class WorkingIndicator implements Component {
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  private readonly cancelSchedule: (timer: NodeJS.Timeout) => void;
  private readonly spinnerStyle: (text: string) => string;
  private readonly messageStyle: (text: string) => string;
  private readonly timerStyle: (text: string) => string;

  private visible = false;
  private spinning = false;
  private phase: WorkingPhase = "idle";
  private message = "Working";
  private startedAt = 0;
  private frameIndex = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly tui: TUI,
    options: WorkingIndicatorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.cancelSchedule = options.cancelSchedule ?? clearInterval;
    this.spinnerStyle = options.spinnerStyle ?? appTheme.ui.primary;
    this.messageStyle =
      options.messageStyle ?? ((text) => renderShimmerText(text, this.frameIndex));
    this.timerStyle = options.timerStyle ?? appTheme.ui.muted;
  }

  start(message: string = "Working"): void {
    this.show(message, true, "thinking");
  }

  private show(message: string, spinning: boolean, phase: WorkingPhase): void {
    const phaseChanged =
      !this.visible ||
      this.message !== message ||
      this.spinning !== spinning ||
      this.phase !== phase;
    this.message = message;
    this.phase = phase;
    if (phaseChanged) {
      this.startedAt = this.now();
      this.frameIndex = 0;
    }
    this.visible = true;
    this.spinning = spinning;
    if (spinning && !this.timer) {
      this.timer = this.schedule(() => {
        this.frameIndex += 1;
        this.tui.requestRender();
      }, 80);
      this.timer.unref?.();
    } else if (!spinning && this.timer) {
      this.cancelSchedule(this.timer);
      this.timer = undefined;
    }
    this.tui.requestRender();
  }

  setMessage(message: string): void {
    this.message = message;
    this.tui.requestRender();
  }

  sync(displayState: SessionDisplayStateLike, approvalPending: boolean): WorkingIndicatorState {
    const next = deriveWorkingIndicatorState(displayState, approvalPending);
    if (next.visible) {
      this.show(next.message, next.spinning, next.phase);
    } else {
      this.stop();
    }
    return next;
  }

  stop(): void {
    if (this.timer) {
      this.cancelSchedule(this.timer);
      this.timer = undefined;
    }
    this.visible = false;
    this.spinning = false;
    this.phase = "idle";
    this.tui.requestRender();
  }

  isActive(): boolean {
    return this.visible;
  }

  render(width: number): string[] {
    if (!this.visible) return [];

    if (!this.spinning) {
      return [
        truncateToWidth(`  ${this.spinnerStyle("•")} ${this.messageStyle(this.message)}`, width),
      ];
    }

    const elapsedSeconds = Math.floor((this.now() - this.startedAt) / 1000);
    const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];

    const spinner = this.spinnerStyle(frame);
    const text = this.messageStyle(this.message);
    const suffix =
      this.phase === "input"
        ? ` • ${formatBinding("cube.turn.interrupt")} to cancel`
        : ` • ${formatBinding("cube.turn.interrupt")} to interrupt`;
    const timer = this.timerStyle(`(${elapsedSeconds}s${suffix})`);

    const line = `  ${spinner} ${text} ${timer}`;
    return [truncateToWidth(line, width), ""];
  }

  invalidate(): void {}
}
