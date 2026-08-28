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
  active: boolean;
  phase: WorkingPhase;
  message: string;
}

interface SessionDisplayStateLike {
  isRunning: boolean;
  currentMessage: null | {
    content?: { parts?: unknown[] };
  };
  activeTools: Map<string, { name: string; status: string }>;
  pendingApproval: unknown | null;
  pendingSuspensions: Map<string, unknown>;
  activeSubagents: Map<
    string,
    { agentType: string; displayName?: string; status: string }
  >;
  omProgress: { status: string };
  bufferingMessages: boolean;
  bufferingObservations: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const deriveWorkingIndicatorState = (
  state: SessionDisplayStateLike,
): WorkingIndicatorState => {
  if (state.pendingApproval) {
    return { active: false, phase: "approval", message: "Waiting for approval" };
  }
  if (state.pendingSuspensions.size > 0) {
    return { active: false, phase: "input", message: "Waiting for input" };
  }

  const activeTool = Array.from(state.activeTools.values()).find(
    (tool) => tool.status === "running" || tool.status === "streaming_input",
  );
  if (activeTool) {
    return {
      active: true,
      phase: "tool",
      message: `Running ${activeTool.name}`,
    };
  }

  const activeSubagent = Array.from(state.activeSubagents.values()).find(
    (subagent) => subagent.status === "running",
  );
  if (activeSubagent) {
    return {
      active: true,
      phase: "subagent",
      message: `Running ${activeSubagent.displayName || activeSubagent.agentType}`,
    };
  }

  if (state.bufferingMessages || state.bufferingObservations) {
    return { active: true, phase: "memory", message: "Buffering memory" };
  }
  if (state.omProgress.status === "observing") {
    return { active: true, phase: "memory", message: "Observing memory" };
  }
  if (state.omProgress.status === "reflecting") {
    return { active: true, phase: "memory", message: "Reflecting memory" };
  }

  if (!state.isRunning) {
    return { active: false, phase: "idle", message: "Idle" };
  }

  const parts = state.currentMessage?.content?.parts ?? [];
  const hasText = parts.some(
    (part) => isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.length > 0,
  );
  if (hasText) {
    return { active: false, phase: "streaming", message: "Responding" };
  }
  const hasReasoning = parts.some(
    (part) => isRecord(part) && part.type === "reasoning",
  );
  if (hasReasoning) {
    return { active: true, phase: "thinking", message: "Thinking" };
  }

  return { active: true, phase: "thinking", message: "Thinking" };
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

  private active = false;
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
      options.schedule ??
      ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.cancelSchedule = options.cancelSchedule ?? clearInterval;
    this.spinnerStyle = options.spinnerStyle ?? appTheme.ui.primary;
    this.messageStyle =
      options.messageStyle ?? ((text) => renderShimmerText(text, this.frameIndex));
    this.timerStyle = options.timerStyle ?? appTheme.ui.muted;
  }

  start(message: string = "Working"): void {
    this.message = message;
    if (this.active) {
      this.tui.requestRender();
      return;
    }
    this.active = true;
    this.startedAt = this.now();
    this.frameIndex = 0;
    this.timer = this.schedule(() => {
      this.frameIndex += 1;
      this.tui.requestRender();
    }, 80);
    this.timer.unref?.();
    this.tui.requestRender();
  }

  setMessage(message: string): void {
    this.message = message;
    this.tui.requestRender();
  }

  sync(displayState: SessionDisplayStateLike): WorkingIndicatorState {
    const next = deriveWorkingIndicatorState(displayState);
    if (next.active) {
      this.start(next.message);
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
    this.active = false;
    this.tui.requestRender();
  }

  isActive(): boolean {
    return this.active;
  }

  render(width: number): string[] {
    if (!this.active) return [];

    const elapsedSeconds = Math.floor((this.now() - this.startedAt) / 1000);
    const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];

    const spinner = this.spinnerStyle(frame);
    const text = this.messageStyle(this.message);
    const timer = this.timerStyle(
      `(${elapsedSeconds}s • ${formatBinding("cube.turn.interrupt")} to interrupt)`,
    );

    const line = `  ${spinner} ${text} ${timer}`;
    return [truncateToWidth(line, width)];
  }

  invalidate(): void {}
}
