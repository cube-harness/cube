import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import chalk, { type ChalkInstance } from "chalk";
import { getTheme } from "../themes/color.schema.js";

export interface UsageBoxContent {
  model: string;
  reasoningEffort?: string;
  capabilities?: string[];
  contextLimit: number;
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

export class UsageBox implements Component {
  invalidate = () => {};

  private paddingX = 2;
  private paddingY = 1;

  constructor(private content: UsageBoxContent) {}

  setContent(content: UsageBoxContent): void {
    this.content = content;
  }

  render = (width: number): string[] => {
    const theme = getTheme();
    const borderChalk = theme.border;
    const titleChalk = theme.assistant;

    const {
      model,
      reasoningEffort,
      capabilities = [],
      contextLimit,
      maxOutput,
      activeTurnTokens,
      promptTokens,
      completionTokens,
      reasoningTokens,
      cachedTokens = 0,
      cacheCreationTokens = 0,
      totalTokens,
      threadTitle,
      threadId,
    } = this.content;

    const currentContextTokens =
      activeTurnTokens !== undefined && activeTurnTokens > 0
        ? activeTurnTokens
        : promptTokens;

    const percent = Math.min(
      100,
      Math.max(0, (currentContextTokens / (contextLimit || 1)) * 100),
    );
    const filledBars = Math.round((percent / 100) * 20);
    const emptyBars = 20 - filledBars;
    const progressBar = `[${"█".repeat(filledBars)}${"░".repeat(emptyBars)}]`;
    const remainingContext = Math.max(0, contextLimit - currentContextTokens);

    const capText = capabilities.length > 0 ? capabilities.join(", ") : "none";
    const maxOutputText = maxOutput ? ` (Max Output: ${maxOutput.toLocaleString()} tokens)` : "";

    const modelDisplay =
      reasoningEffort && reasoningEffort !== "none"
        ? `${model} (${reasoningEffort})`
        : model;

    let cachedDisplay = `${cachedTokens.toLocaleString()}`;
    if (cacheCreationTokens > 0) {
      cachedDisplay += ` (Read: ${cachedTokens.toLocaleString()}, Write: ${cacheCreationTokens.toLocaleString()})`;
    }

    const promptDisplay =
      activeTurnTokens !== undefined &&
      activeTurnTokens > 0 &&
      activeTurnTokens !== promptTokens
        ? `${promptTokens.toLocaleString()} (Active Turn: ${activeTurnTokens.toLocaleString()})`
        : promptTokens.toLocaleString();

    const contentLines: string[] = [
      `${theme.primary("Model            :")} ${modelDisplay}`,
      `${theme.primary("Capabilities     :")} ${capText}`,
      `${theme.primary("Context Limit    :")} ${contextLimit.toLocaleString()} tokens${maxOutputText}`,
      `${theme.primary("Context Window   :")} ${progressBar} ${percent.toFixed(1)}% (${currentContextTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens)`,
      `${theme.primary("Remaining Space  :")} ${remainingContext.toLocaleString()} tokens`,
      "",
      `${theme.primary("Prompt Tokens    :")} ${promptDisplay}`,
      `${theme.primary("Completion Tokens:")} ${completionTokens.toLocaleString()}`,
    ];

    if (reasoningTokens !== undefined && reasoningTokens > 0) {
      contentLines.push(
        `${theme.primary("Reasoning Tokens :")} ${reasoningTokens.toLocaleString()}`,
      );
    }

    contentLines.push(
      `${theme.primary("Cached Tokens    :")} ${cachedDisplay}`,
      `${theme.primary("Total Tokens     :")} ${totalTokens.toLocaleString()}`,
      "",
    );

    if (threadTitle) {
      contentLines.push(`${theme.primary("Thread Title     :")} ${threadTitle}`);
    }

    contentLines.push(`${theme.primary("Thread ID        :")} ${threadId}`);

    let maxTextWidth = 0;
    for (const line of contentLines) {
      const w = visibleWidth(line);
      if (w > maxTextWidth) maxTextWidth = w;
    }

    const title = " Usage & Context Statistics ";
    const titleWidth = visibleWidth(title);

    const innerWidth = this.paddingX * 2 + maxTextWidth;
    const idealBoxWidth = Math.max(innerWidth + 2, titleWidth + 6);
    const boxWidth = Math.min(width, idealBoxWidth);
    const effectiveInnerWidth = boxWidth - 2;

    const rightDashCount = Math.max(0, boxWidth - titleWidth - 3);
    const topLine =
      borderChalk("╭─") +
      titleChalk(title) +
      borderChalk("─".repeat(rightDashCount)) +
      borderChalk("╮");
    const bottomLine =
      borderChalk("╰") + borderChalk("─".repeat(boxWidth - 2)) + borderChalk("╯");

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

      renderedLines.push(
        `${borderChalk("│")}${combinedLeft}${rightPad}${borderChalk("│")}`,
      );
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
): string => {
  const box = new UsageBox(content);
  return box.render(width).join("\n");
};
