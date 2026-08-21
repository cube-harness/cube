import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
    const theme = getTheme();
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ??
      ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.cancelSchedule = options.cancelSchedule ?? clearInterval;
    this.spinnerStyle = options.spinnerStyle ?? theme.primary;
    this.messageStyle = options.messageStyle ?? theme.muted;
    this.timerStyle = options.timerStyle ?? theme.secondary;
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
    const timer = this.timerStyle(`(${elapsedSeconds}s)`);

    const line = ` ${spinner} ${text} ${timer}`;
    return [truncateToWidth(line, width)];
  }

  invalidate(): void {}
}
