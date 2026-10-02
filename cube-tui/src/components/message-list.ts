// cube-tui/src/components/message-list.ts
import {
  wrapTextWithAnsi,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";
import { Markdown } from "./markdown.js";
import { formatBinding } from "../keybindings.js";
import type { ChatMessage, DisplayTool, MessageRole } from "../types/view.types.js";
import { fileChanges, commandResult, renderToolDiff, toolText } from "./tool-diff.js";
import { getSyntaxTheme } from "../themes/syntax.theme.js";
import type { RuntimeDisplayState } from "@cube/runtime";

export type { ChatMessage, DisplayTool, MessageRole } from "../types/view.types.js";

interface CachedEntry {
  message: ChatMessage;
  cachedWidth?: number;
  cachedLines?: string[];
}

const stringifyDisplayValue = (value: unknown): string => {
  if (typeof value === "string") return value.trimEnd();
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

const formatToolHeader = (toolName: string, args: unknown): string => {
  let cmdPart = "";
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    if (typeof record.command === "string") {
      cmdPart = ` $ ${record.command}`;
    } else if (typeof record.cmd === "string") {
      cmdPart = ` $ ${record.cmd}`;
    } else if (typeof record.path === "string") {
      cmdPart = ` ${record.path}`;
    } else if (typeof record.filePath === "string") {
      cmdPart = ` ${record.filePath}`;
    } else if (typeof record.file === "string") {
      cmdPart = ` ${record.file}`;
    } else if (typeof record.query === "string") {
      cmdPart = ` "${record.query}"`;
    }
  } else if (args !== undefined && args !== null) {
    const raw = stringifyDisplayValue(args);
    if (raw) cmdPart = ` ${raw}`;
  }
  return `${appTheme.role.tool(toolName)}${cmdPart ? appTheme.ui.muted(cmdPart) : ""}`;
};

const COLLAPSED_TOOL_LINES = 2;

const toolOutput = (tool: DisplayTool): string =>
  tool.shellOutput?.trimEnd() ||
  tool.partialResult?.trimEnd() ||
  stringifyDisplayValue(tool.result);

const createToolMessage = (tool: DisplayTool): ChatMessage => {
  const header = formatToolHeader(tool.name, tool.args);
  const output = toolOutput(tool);

  const contentLines: string[] = [header];
  if (output) contentLines.push(appTheme.ui.muted(output));

  return {
    id: tool.id,
    role: "tool",
    toolName: tool.name,
    tool,
    content: contentLines.join("\n"),
    status:
      tool.status === "error" || tool.status === "declined"
        ? "error"
        : tool.status === "completed"
          ? "done"
          : "pending",
  };
};

type SessionMessageLike = {
  id?: string;
  role?: string;
  createdAt?: Date | string;
  content?: string | { parts?: unknown[]; metadata?: Record<string, unknown> };
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const reasoningContent = (part: Record<string, unknown>): string => {
  if (typeof part.reasoning === "string" && part.reasoning.trim()) {
    return part.reasoning.trim();
  }
  if (typeof part.text === "string" && part.text.trim()) {
    return part.text.trim();
  }
  if (!Array.isArray(part.details)) return "";
  return part.details
    .flatMap((detail) => {
      const record = asRecord(detail);
      return record && typeof record.text === "string" && record.text.trim()
        ? [record.text.trim()]
        : [];
    })
    .join("\n");
};

const timestampMs = (value: unknown): number | undefined => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const persistedReasoningDuration = (
  raw: SessionMessageLike,
  parts: unknown[],
  reasoningIndex: number,
): number | undefined => {
  const reasoning = asRecord(parts[reasoningIndex]);
  const endedAt = timestampMs(reasoning?.createdAt);
  if (endedAt === undefined) return undefined;

  let startedAt: number | undefined;
  for (let index = reasoningIndex - 1; index >= 0; index -= 1) {
    startedAt = timestampMs(asRecord(parts[index])?.createdAt);
    if (startedAt !== undefined) break;
  }
  startedAt ??= timestampMs(raw.createdAt);
  if (startedAt === undefined || endedAt <= startedAt) return undefined;
  return endedAt - startedAt;
};

const sessionToolStatus = (invocation: Record<string, unknown>): DisplayTool["status"] => {
  const state = typeof invocation.state === "string" ? invocation.state : "";
  if (state === "input-streaming") return "streaming_input";
  if (state === "result" || state === "output-available") {
    return invocation.isError === true ? "error" : "completed";
  }
  if (state === "error" || state === "output-error") return "error";
  if (state === "declined" || state === "approval-rejected" || state === "output-denied")
    return "declined";
  if (state.includes("approval")) return "waiting_approval";
  return "running";
};

const hasMeaningfulToolArgs = (args: unknown): boolean => {
  if (args === undefined || args === null) return false;
  if (typeof args === "string") return args.trim().length > 0;
  if (Array.isArray(args)) return args.length > 0;
  if (typeof args === "object") return Object.keys(args).length > 0;
  return true;
};

const shouldRenderActiveTool = (tool: DisplayTool): boolean =>
  tool.status !== "streaming_input" || hasMeaningfulToolArgs(tool.args);

const mapSessionMessage = (
  raw: SessionMessageLike,
  streaming: boolean,
  reasoningDurationMs?: number,
  pendingApproval?: RuntimeDisplayState["pendingApproval"],
): ChatMessage[] => {
  const sourceMessageId = raw.id ?? `message-${Date.now()}`;
  const timestamp = raw.createdAt ? new Date(raw.createdAt) : new Date();
  if (typeof raw.content === "string") {
    return raw.content.trim()
      ? [
          {
            id: sourceMessageId,
            sourceMessageId,
            role:
              raw.role === "assistant" ? "assistant" : raw.role === "system" ? "system" : "user",
            content: raw.content,
            timestamp,
            status: streaming ? "streaming" : "done",
          },
        ]
      : [];
  }

  const metadata = raw.content?.metadata;
  const signalType = asRecord(metadata?.signal)?.type;
  const userAuthored = raw.role === "user" || (raw.role === "signal" && ["user", "user-message"].includes(String(signalType)));
  const displayText = userAuthored ? asRecord(metadata?.cube)?.displayText : undefined;
  const originalParts = raw.content?.parts ?? [];
  const parts = typeof displayText === "string"
    ? [{ type: "text", text: displayText }, ...originalParts.filter((part) => asRecord(part)?.type !== "text")]
    : originalParts;
  const messages: ChatMessage[] = [];
  let textIndex = 0;
  let reasoningRendered = false;
  for (const [partIndex, part] of parts.entries()) {
    const record = asRecord(part);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string" && record.text.trim()) {
      textIndex += 1;
      messages.push({
        id: `${sourceMessageId}:text-${textIndex}`,
        sourceMessageId,
        role: raw.role === "assistant" ? "assistant" : raw.role === "system" ? "system" : "user",
        content: record.text,
        timestamp,
        status: streaming ? "streaming" : "done",
      });
      continue;
    }
    if (record.type === "reasoning" && !reasoningRendered && reasoningContent(record)) {
      const hasFollowingOutput = parts.slice(partIndex + 1).some((candidate) => {
        const following = asRecord(candidate);
        if (!following) return false;
        if (following.type === "text") {
          return typeof following.text === "string" && following.text.trim().length > 0;
        }
        return following.type === "tool-invocation";
      });
      if (streaming && !hasFollowingOutput) continue;
      reasoningRendered = true;
      const durationMs = reasoningDurationMs ?? persistedReasoningDuration(raw, parts, partIndex);
      const durationLabel =
        durationMs && durationMs > 0 ? ` for ${Math.max(1, Math.floor(durationMs / 1_000))}s` : "";
      messages.push({
        id: `${sourceMessageId}:reasoning`,
        sourceMessageId,
        role: "reasoning",
        content: `Reasoning${durationLabel}`,
        transcriptContent: reasoningContent(record),
        timestamp,
        status: "done",
      });
      continue;
    }
    if (record.type !== "tool-invocation") continue;
    const invocation = asRecord(record.toolInvocation);
    if (!invocation) continue;
    const toolCallId =
      typeof invocation.toolCallId === "string" ? invocation.toolCallId : undefined;
    const toolName = typeof invocation.toolName === "string" ? invocation.toolName : undefined;
    if (!toolCallId || !toolName) continue;
    const invocationStatus = sessionToolStatus(invocation);
    const approval =
      (invocationStatus === "running" || invocationStatus === "waiting_approval") &&
      pendingApproval?.toolCallId === toolCallId
        ? pendingApproval
        : undefined;
    const invocationResult =
      invocation.result ?? invocation.output ?? invocation.error ?? asRecord(invocation.approval)?.reason;
    const tool: DisplayTool = {
      id: toolCallId,
      name: toolName,
      args: approval?.args ?? invocation.args ?? invocation.input ?? {},
      status: approval ? "waiting_approval" : invocationStatus,
      result: invocationResult,
    };
    if (!shouldRenderActiveTool(tool)) continue;
    messages.push({
      ...createToolMessage(tool),
      sourceMessageId,
      timestamp,
    });
  }
  return messages;
};

export class MessageList implements Component {
  private entries: CachedEntry[] = [];
  private transcriptExpanded = false;
  private syntaxTheme = getSyntaxTheme();

  invalidate(): void {
    for (const entry of this.entries) {
      entry.cachedWidth = undefined;
      entry.cachedLines = undefined;
    }
  }

  setMessages(messages: ChatMessage[]) {
    this.entries = messages.map((message) => ({
      message: {
        ...(message.tool ? createToolMessage(message.tool) : message),
        timestamp: message.timestamp ?? new Date(),
      },
    }));
    this.invalidate();
  }

  clearMessages() {
    this.entries = [];
    this.invalidate();
  }

  addMessage(msg: ChatMessage | string) {
    const chatMsg: ChatMessage =
      typeof msg === "string"
        ? { role: "user", content: msg, timestamp: new Date() }
        : { ...msg, timestamp: msg.timestamp ?? new Date() };

    this.entries.push({ message: chatMsg });
  }

  upsertMessage(msg: ChatMessage) {
    if (msg.id) {
      const existing = this.entries.find((e) => e.message.id === msg.id);
      if (existing) {
        existing.message.content = msg.content;
        existing.message.transcriptContent = msg.transcriptContent;
        existing.message.status = msg.status ?? "done";
        existing.message.toolName = msg.toolName ?? existing.message.toolName;
        existing.message.tool = msg.tool ?? existing.message.tool;
        existing.cachedWidth = undefined;
        existing.cachedLines = undefined;
        return;
      }
    }
    this.addMessage(msg);
  }

  upsertTool(tool: DisplayTool) {
    this.upsertMessage(createToolMessage(tool));
  }

  setSessionMessages(messages: readonly SessionMessageLike[]): void {
    this.setMessages(messages.flatMap((message) => mapSessionMessage(message, false)));
  }

  applySessionMessage(
    message: SessionMessageLike,
    streaming: boolean,
    reasoningDurationMs?: number,
    pendingApproval?: RuntimeDisplayState["pendingApproval"],
  ): void {
    const mapped = mapSessionMessage(message, streaming, reasoningDurationMs, pendingApproval);
    if (!message.id) {
      for (const item of mapped) this.upsertMessage(item);
      return;
    }

    const sourceId = message.id;
    const mappedToolIds = new Set(mapped.flatMap((item) => (item.tool ? [item.tool.id] : [])));
    const existingIndices = this.entries
      .map((entry, index) =>
        entry.message.sourceMessageId === sourceId ||
        (entry.message.tool && mappedToolIds.has(entry.message.tool.id))
          ? index
          : -1,
      )
      .filter((index) => index >= 0);
    const insertAt =
      existingIndices.length > 0 ? Math.min(...existingIndices) : this.entries.length;
    this.entries = this.entries.filter(
      (entry) =>
        entry.message.sourceMessageId !== sourceId &&
        (!entry.message.tool || !mappedToolIds.has(entry.message.tool.id)),
    );
    this.entries.splice(
      Math.min(insertAt, this.entries.length),
      0,
      ...mapped.map((item) => ({ message: item })),
    );
  }

  toggleTranscript(): boolean {
    this.transcriptExpanded = !this.transcriptExpanded;
    this.invalidate();
    return this.transcriptExpanded;
  }

  getMessages(): ChatMessage[] {
    return this.entries.map((e) => e.message);
  }

  /**
   * FIX: `system` used `theme.warning` and `tool` used `theme.success` — both
   * SIGNAL-tier hues borrowed for ACTOR-tier roles. `color.schema.ts` already
   * defines dedicated `system` and `tool` ACTOR hues, hue-separated (>=35°)
   * from everything else specifically so each role reads as its own actor —
   * they were simply never wired up here. Side effect of the old code: every
   * tool call's bullet was green (`success`) regardless of whether the tool
   * actually succeeded or failed, which is actively misleading, not just
   * miscolored.
   */
  private formatRolePrefix(msg: ChatMessage): string {
    switch (msg.role) {
      case "user":
        return appTheme.ui.primary("  ❯ ");
      case "assistant":
        return appTheme.role.assistant("  ❖ ");
      case "system":
        return appTheme.ui.tertiary("  ❖ ");
      case "tool":
        return appTheme.ui.secondary("  ❖ ");
      case "reasoning":
        return appTheme.ui.muted("  ♦ ");
    }
  }

  private contentColorFor(role: MessageRole): (text: string) => string {
    switch (role) {
      case "user":
        return appTheme.role.user;
      case "system":
        return appTheme.role.system;
      case "tool":
        return appTheme.role.tool;
      case "reasoning":
        return appTheme.ui.muted;
      default:
        return appTheme.role.assistant;
    }
  }

  private renderMessage(entry: CachedEntry, width: number): string[] {
    const availableWidth = Math.max(width, 1);
    const msg = entry.message;
    const prefix = this.formatRolePrefix(msg);
    const prefixWidth = visibleWidth(prefix);
    const indent = " ".repeat(prefixWidth);
    const contentWidth = Math.max(1, availableWidth - prefixWidth);
    const lines: string[] = [];

    if (msg.role === "assistant") {
      const markdown = new Markdown(msg.content);
      const renderedLines = markdown.render(contentWidth);
      renderedLines.forEach((line, index) => {
        const combined = `${index === 0 ? prefix : indent}${line}`;
        lines.push(truncateToWidth(combined, availableWidth));
      });
      lines.push("");
      return lines;
    }

    if (msg.role === "tool") {
      const tool = msg.tool;
      const header = toolText(tool ? formatToolHeader(tool.name, tool.args) : msg.content);
      const headerLines = wrapTextWithAnsi(header, contentWidth);
      if (headerLines.length === 0) {
        lines.push(truncateToWidth(prefix, availableWidth));
      } else {
        headerLines.forEach((line, index) => {
          lines.push(truncateToWidth(`${index === 0 ? prefix : indent}${line}`, availableWidth));
        });
      }

      const changes =
        fileChanges(tool?.result) ??
        (tool?.status === "waiting_approval" ? fileChanges(asRecord(tool.args)?.preview) : undefined);
      if (changes) {
        lines.push(...renderToolDiff(changes, availableWidth, this.transcriptExpanded, prefixWidth));
        lines.push("");
        return lines;
      }
      const command = commandResult(tool?.result);
      const args = asRecord(tool?.args);
      const reason =
        command?.reason ?? (typeof args?.reason === "string" ? args.reason : undefined);
      const cwd = command?.cwd ?? (typeof args?.cwd === "string" ? args.cwd : undefined);
      for (const detail of [
        reason && `Reason: ${reason}`,
        cwd && `Directory: ${cwd}`,
        command &&
          `${command.status}${command.exit_code === null ? "" : ` · exit ${command.exit_code}`}${command.truncated ? " · output truncated" : ""}`,
      ]) {
        if (detail)
          for (const line of wrapTextWithAnsi(appTheme.ui.muted(toolText(detail)), contentWidth))
            lines.push(truncateToWidth(`${indent}${line}`, availableWidth));
      }
      const output = toolText(command ? command.output : tool ? toolOutput(tool) : "");
      if (output) {
        const outputLines = output.split(/\r?\n/).flatMap((line) => {
          const wrapped = wrapTextWithAnsi(appTheme.ui.muted(line), contentWidth);
          return wrapped.length > 0 ? wrapped : [""];
        });
        const visibleOutput = this.transcriptExpanded
          ? outputLines
          : outputLines.slice(0, COLLAPSED_TOOL_LINES);
        for (const line of visibleOutput) {
          lines.push(truncateToWidth(`${indent}${line}`, availableWidth));
        }
        if (!this.transcriptExpanded && outputLines.length > COLLAPSED_TOOL_LINES) {
          const hidden = outputLines.length - COLLAPSED_TOOL_LINES;
          const hint = `… +${hidden} lines (${formatBinding("cube.transcript.toggle")} to view transcript)`;
          for (const line of wrapTextWithAnsi(appTheme.ui.muted(hint), contentWidth)) {
            lines.push(truncateToWidth(`${indent}${line}`, availableWidth));
          }
        }
      }
      lines.push("");
      return lines;
    }

    if (msg.role === "user") {
      const background = appTheme.surface.background;
      const userPrefix = appTheme.ui.primary.bgHex(background)("  ❯ ");
      const userIndent = appTheme.ui.text.bgHex(background)("    ");
      const verticalPadding = appTheme.ui.text.bgHex(background)(" ".repeat(availableWidth));
      const contentLines = msg.content.split(/\r?\n/);

      lines.push(verticalPadding);
      for (let index = 0; index < contentLines.length; index++) {
        const wrapped = wrapTextWithAnsi(
          appTheme.role.user.bgHex(background)(contentLines[index]),
          contentWidth,
        );
        const renderedRows = wrapped.length > 0 ? wrapped : [""];

        renderedRows.forEach((row, rowIndex) => {
          const linePrefix = index === 0 && rowIndex === 0 ? userPrefix : userIndent;
          const content = `${linePrefix}${row}`;
          const padding = appTheme.ui.text.bgHex(background)(
            " ".repeat(Math.max(0, availableWidth - visibleWidth(content))),
          );
          lines.push(truncateToWidth(`${content}${padding}`, availableWidth));
        });
      }

      lines.push(verticalPadding);
      lines.push("");
      return lines;
    }

    // Fallback: user / system / reasoning messages.
    const contentLines = msg.content.split(/\r?\n/);
    const color = this.contentColorFor(msg.role);
    if (contentLines.length > 0) {
      const firstLineWrapped = wrapTextWithAnsi(color(contentLines[0]), contentWidth);
      if (firstLineWrapped.length === 0) {
        lines.push(truncateToWidth(prefix, availableWidth));
      } else {
        firstLineWrapped.forEach((wLine, wIdx) => {
          const linePrefix = wIdx === 0 ? prefix : indent;
          lines.push(truncateToWidth(`${linePrefix}${wLine}`, availableWidth));
        });
      }
      for (let i = 1; i < contentLines.length; i++) {
        const restWrapped = wrapTextWithAnsi(color(contentLines[i]), contentWidth);
        for (const wLine of restWrapped) {
          lines.push(truncateToWidth(`${indent}${wLine}`, availableWidth));
        }
      }
    }
    if (msg.role === "reasoning" && this.transcriptExpanded && msg.transcriptContent) {
      for (const transcriptLine of msg.transcriptContent.split(/\r?\n/)) {
        const wrapped = wrapTextWithAnsi(color(transcriptLine), contentWidth);
        for (const line of wrapped.length > 0 ? wrapped : [""]) {
          lines.push(truncateToWidth(`${indent}${line}`, availableWidth));
        }
      }
    }
    lines.push("");
    return lines;
  }

  render(width: number): string[] {
    const syntaxTheme = getSyntaxTheme();
    if (this.syntaxTheme !== syntaxTheme) {
      this.syntaxTheme = syntaxTheme;
      this.invalidate();
    }
    if (this.entries.length === 0) {
      return [];
    }

    const availableWidth = Math.max(width, 1);
    const allLines: string[] = [];

    for (const entry of this.entries) {
      if (entry.cachedLines && entry.cachedWidth === availableWidth) {
        allLines.push(...entry.cachedLines);
      } else {
        const lines = this.renderMessage(entry, availableWidth);
        entry.cachedLines = lines;
        entry.cachedWidth = availableWidth;
        allLines.push(...lines);
      }
    }

    return allLines;
  }
}
