import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";

export interface UsageBoxContent {
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
    const filledBars = Math.round((percent / 100) * 20);
    const emptyBars = 20 - filledBars;
    const progressBar = `${appTheme.status.success("█".repeat(filledBars))}${appTheme.ui.muted("░".repeat(emptyBars))}`;

    const capText = capabilities.length > 0
      ? capabilities.join(", ") + (this.content.capabilitiesComplete === false ? " (others unknown)" : "")
      : this.content.capabilitiesComplete === true ? "none" : "unknown";

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

    contentLines.push(
      "",
      contextLimit === undefined ? `${appTheme.ui.muted("Context Window   :")} unknown (${formatTokensK(currentContextTokens)} tokens used)` : `${appTheme.ui.muted("Context Window   :")} [${progressBar}] ${appTheme.ui.primary(percent.toFixed(1) + "%")} ${appTheme.ui.muted(`(${formatTokensK(currentContextTokens)} / ${formatTokensK(contextLimit)} tokens)`)}`,
    );

    if (cachedTokens > 0 || cacheCreationTokens > 0) {
      contentLines.push(
        `${appTheme.ui.muted("Cache            :")} ${appTheme.ui.text(cachedDisplay)}`,
      );
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
