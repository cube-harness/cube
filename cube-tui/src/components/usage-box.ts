import type { Component } from "@earendil-works/pi-tui";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SubscriptionUsage } from "@cube/runtime";
import { appTheme } from "../themes/app.theme.js";

export interface UsageBoxContent {
  subscription?: SubscriptionUsage;
  title?: string;
  model: string;
  reasoningEffort?: string;
  capabilities?: string[];
  directory?: string;
  sessionId?: string;
  capabilitiesComplete?: boolean;
  contextLimit?: number;
  maxOutput?: number;
  activeTurnTokens?: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  totalTokens: number;
  threadTitle?: string;
  threadId: string;
}

const formatTokensK = (tokens: number): string => {
  if (tokens <= 0) return "0";
  if (tokens >= 1_048_576) {
    const m = tokens / 1_048_576;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (tokens >= 1024) {
    const k = tokens / 1024;
    return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
  }
  return tokens.toLocaleString();
};

export class UsageBox implements Component {
  invalidate = () => {};

  private paddingX = 2;
  private paddingY = 1;
  private title = "Session Status";

  constructor(
    title: string = "Session Status",
    private content?: UsageBoxContent,
  ) {
    this.title = title;
  }

  setTitle(title: string): void {
    this.title = title;
  }

  setContent(content: UsageBoxContent): void {
    this.content = content;
    if (content.title) {
      this.title = content.title;
    }
  }

  render = (width: number): string[] => {
    if (!this.content) return [];

    const borderChalk = appTheme.ui.border;
    const titleChalk = appTheme.ui.primary.bold;

    const {
      model,
      reasoningEffort,
      capabilities = [],
      directory,
      sessionId,
      contextLimit,
      activeTurnTokens,
      promptTokens,
      cachedTokens = 0,
      cacheCreationTokens = 0,
      threadTitle,
      threadId,
    } = this.content;

    const currentContextTokens =
      activeTurnTokens !== undefined && activeTurnTokens > 0 ? activeTurnTokens : promptTokens;

    const percent = Math.min(100, Math.max(0, (currentContextTokens / (contextLimit || 1)) * 100));
    const progressBar = (value: number, cells = 20) => {
      const filled = Math.round(Math.min(100, Math.max(0, value)) / 100 * cells);
      return `${appTheme.status.success("█".repeat(filled))}${appTheme.ui.muted("░".repeat(cells - filled))}`;
    };

    const capText =
      capabilities.length > 0
        ? capabilities.join(", ") +
          (this.content.capabilitiesComplete === false ? " (others unknown)" : "")
        : this.content.capabilitiesComplete === true
          ? "none"
          : "unknown";

    const modelDisplay =
      reasoningEffort && reasoningEffort !== "none" ? `${model} (${reasoningEffort})` : model;

    let cachedDisplay = `${formatTokensK(cachedTokens)} (Read)`;
    if (cacheCreationTokens > 0) {
      cachedDisplay = `${formatTokensK(cachedTokens)} (Read: ${formatTokensK(cachedTokens)}, Write: ${formatTokensK(cacheCreationTokens)})`;
    }

    const contentLines: string[] = [
      `${appTheme.ui.muted("Model            :")} ${appTheme.ui.text(modelDisplay)}`,
      `${appTheme.ui.muted("Capabilities     :")} ${appTheme.ui.text(capText)}`,
    ];

    if (directory) {
      contentLines.push(
        `${appTheme.ui.muted("Directory        :")} ${appTheme.ui.text(directory)}`,
      );
    }

    if (sessionId) {
      contentLines.push(
        `${appTheme.ui.muted("Session ID       :")} ${appTheme.ui.text(sessionId)}`,
      );
    }

    contentLines.push(`${appTheme.ui.muted("Thread ID        :")} ${appTheme.ui.text(threadId)}`);

    if (threadTitle) {
      contentLines.push(
        `${appTheme.ui.muted("Thread Title     :")} ${appTheme.ui.text(threadTitle)}`,
      );
    }

    contentLines.push("");
    const subscription = this.content.subscription;
    const label = (text: string) => stripTerminalSequences(text).replace(/[\r\n\t]/g, " ");
    if (subscription || cachedTokens > 0 || cacheCreationTokens > 0) {
      contentLines.push(
        `${appTheme.ui.muted("Cache            :")} ${appTheme.ui.text(cachedDisplay)}`,
      );
    }

    contentLines.push(
      contextLimit === undefined
        ? `${appTheme.ui.muted("Context Window   :")} unknown (${formatTokensK(currentContextTokens)} tokens used)`
        : `${appTheme.ui.muted("Context Window   :")} [${progressBar(percent)}] ${appTheme.ui.primary(percent.toFixed(1) + "%")} ${appTheme.ui.muted(`(${formatTokensK(currentContextTokens)} / ${formatTokensK(contextLimit)} tokens)`)}`,
    );

    const noQuota = `${appTheme.ui.muted("Quota            :")} ${appTheme.ui.text("No data")}`;
    if (subscription && !subscription.limits.length) contentLines.push(noQuota);
    for (const limit of subscription?.limits ?? []) {
      const creditRow = limit.windows.length === 1 && ["Credits", "Balance"].includes(limit.windows[0].name);
      if ((!creditRow && !["Codex", "Claude", "Grok Build"].includes(limit.name)) || limit.limitReached || limit.allowed === false) {
        contentLines.push(
          appTheme.ui.muted(label(limit.name)) +
            (limit.limitReached
              ? " · Limit reached"
              : limit.allowed === false
                ? " · Unavailable"
                : ""),
        );
      }
      if (!limit.windows.length) contentLines.push(noQuota);
      for (const window of limit.windows) {
        const seconds = window.windowSeconds;
        const duration =
          seconds === 604800
            ? "Weekly"
            : !seconds
              ? window.name
              : seconds % 86400 === 0
                ? `${seconds / 86400}d`
                : seconds % 3600 === 0
                  ? `${seconds / 3600}h`
                  : seconds % 60 === 0
                    ? `${seconds / 60}m`
                    : `${seconds}s`;
        const left = window.usedPercent === undefined ? undefined
          : Math.round(Math.min(100, Math.max(0, 100 - window.usedPercent)) * 10) / 10;
        const resetDate = window.resetsAt === undefined ? undefined : new Date(window.resetsAt * 1000);
        const reset = resetDate
          ? resetDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) +
            (seconds === undefined || seconds >= 86400 ? ` on ${resetDate.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" })}` : "")
          : "unknown";
        const amount = window.remaining === undefined ? "No usage data"
          : `${window.remaining.toLocaleString("en-GB")} ${label(window.unit ?? "units")} left`;
        const heading = creditRow ? label(limit.name) : `${label(duration)}${window.remaining !== undefined && left === undefined ? "" : " limit"}`;
        const prefix = `${appTheme.ui.muted(heading.padEnd(17) + ":")} `;
        const resetText = window.name === "Balance" && !resetDate ? "" : appTheme.ui.muted(`(resets ${reset})`);
        const availableBarCells = width - 2 - this.paddingX * 2 - visibleWidth(prefix)
          - `${left}% left`.length - (resetText ? visibleWidth(resetText) + 1 : 0) - 3;
        const barCells = Math.max(5, Math.min(20, availableBarCells));
        const row = `${prefix}${left === undefined ? appTheme.ui.text(amount) : `[${progressBar(left, barCells)}] ${appTheme.ui.primary(`${left}% left`)}`}`;
        const line = resetText ? `${row} ${resetText}` : row;
        if (resetText && visibleWidth(line) > width - 2 - this.paddingX * 2)
          contentLines.push(row, `  ${resetText}`);
        else contentLines.push(line);
      }
    }

    let maxTextWidth = 0;
    for (const line of contentLines) {
      const w = visibleWidth(line);
      if (w > maxTextWidth) maxTextWidth = w;
    }

    const formattedTitle = ` ${this.title} `;
    const titleWidth = visibleWidth(formattedTitle);

    const innerWidth = this.paddingX * 2 + maxTextWidth;
    const idealBoxWidth = Math.max(innerWidth + 2, titleWidth + 6);
    const boxWidth = Math.min(width, idealBoxWidth);
    const effectiveInnerWidth = boxWidth - 2;

    const rightDashCount = Math.max(0, boxWidth - titleWidth - 3);
    const topLine =
      borderChalk("╭─") +
      titleChalk(formattedTitle) +
      borderChalk("─".repeat(rightDashCount)) +
      borderChalk("╮");
    const bottomLine = borderChalk("╰") + borderChalk("─".repeat(boxWidth - 2)) + borderChalk("╯");

    const renderedLines: string[] = [topLine];

    for (let i = 0; i < this.paddingY; i++) {
      renderedLines.push(
        `${borderChalk("│")}${" ".repeat(effectiveInnerWidth)}${borderChalk("│")}`,
      );
    }

    const padXStr = " ".repeat(this.paddingX);
    for (const rawLine of contentLines) {
      let textLine = rawLine;
      const maxAllowedTextWidth = Math.max(0, effectiveInnerWidth - this.paddingX * 2);
      if (visibleWidth(textLine) > maxAllowedTextWidth) {
        textLine = truncateToWidth(textLine, maxAllowedTextWidth);
      }

      const combinedLeft = `${padXStr}${textLine}`;
      const combinedVisWidth = visibleWidth(combinedLeft);
      const rightSpaceCount = Math.max(0, effectiveInnerWidth - combinedVisWidth);
      const rightPad = " ".repeat(rightSpaceCount);

      renderedLines.push(`${borderChalk("│")}${combinedLeft}${rightPad}${borderChalk("│")}`);
    }

    for (let i = 0; i < this.paddingY; i++) {
      renderedLines.push(
        `${borderChalk("│")}${" ".repeat(effectiveInnerWidth)}${borderChalk("│")}`,
      );
    }

    renderedLines.push(bottomLine);
    return renderedLines;
  };
}

export const renderUsageBoxToString = (
  content: UsageBoxContent,
  width: number = 80,
  title: string = "Session Status",
): string => {
  const box = new UsageBox(content.title || title, content);
  return box.render(width).join("\n");
};
