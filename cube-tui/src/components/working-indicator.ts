import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";

export interface WorkingIndicatorOptions {
  now?: () => number;
  schedule?: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  cancelSchedule?: (timer: NodeJS.Timeout) => void;
  baseStyle?: (text: string) => string;
  highlightStyle?: (text: string) => string;
}

export class WorkingIndicator implements Component {
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  private readonly cancelSchedule: (timer: NodeJS.Timeout) => void;
  private readonly baseStyle: (text: string) => string;
  private readonly highlightStyle: (text: string) => string;
  private active = false;
  private startedAt = 0;
  private highlightIndex = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly tui: TUI,
    options: WorkingIndicatorOptions = {},
  ) {
    const theme = getTheme();
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.cancelSchedule = options.cancelSchedule ?? clearInterval;
    this.baseStyle = options.baseStyle ?? theme.muted;
    this.highlightStyle = options.highlightStyle ?? theme.primary;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.startedAt = this.now();
    this.highlightIndex = 0;
    this.timer = this.schedule(() => {
      this.highlightIndex += 1;
      this.tui.requestRender();
    }, 80);
    this.timer.unref?.();
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

  render(width: number): string[] {
    if (!this.active) return [];

    const elapsedSeconds = Math.max(0, Math.floor((this.now() - this.startedAt) / 1_000));
    const label = `Working (${elapsedSeconds}s)`;
    const brightAt = this.highlightIndex % label.length;
    const animated = [...label]
      .map((character, index) => (
        index === brightAt
          ? this.highlightStyle(character)
          : this.baseStyle(character)
      ))
      .join("");

    return [truncateToWidth(animated, width)];
  }

  invalidate(): void {}
}
