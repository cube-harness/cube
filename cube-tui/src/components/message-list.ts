// cube-tui/src/components/message-list.ts
import {
  Markdown,
  wrapTextWithAnsi,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";
import { createMarkdownTheme } from "../themes/pi-tui.theme.js";
import { formatBinding } from "../keybindings.js";

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id?: string;
  role: MessageRole;
  content: string;
  timestamp?: Date;
  status?: "pending" | "streaming" | "done" | "error";
  toolName?: string;
  tool?: DisplayTool;
  sourceMessageId?: string;
}

export interface DisplayTool {
  id: string;
  name: string;
  args: unknown;
  status:
    | "streaming_input"
    | "waiting_approval"
    | "running"
    | "completed"
    | "error"
    | "declined";
  partialResult?: string;
  result?: unknown;
  shellOutput?: string;
}

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

/**
 * FIX: was `theme.assistant(toolName)` — the tool's own name was rendered
 * in the ASSISTANT hue, not the dedicated `tool` hue that color.schema.ts
 * carefully hue-separates (>=35°) from every other ACTOR token specifically
 * so tool calls are visually distinguishable from the agent's own prose.
 * Measured on a real run: this is one of the two causes of tool output and
 * assistant text reading as the same flat gray wall (see message content
 * fix below for the other).
 */
const formatToolHeader = (toolName: string, args: unknown): string => {
  const theme = getTheme();
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
  return `${theme.tool(toolName)}${cmdPart ? theme.muted(cmdPart) : ""}`;
};

const formatToolExtraArgs = (args: unknown): string | null => {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  if (
    "command" in record ||
    "cmd" in record ||
    "path" in record ||
    "filePath" in record ||
    "file" in record ||
    "query" in record
  ) {
    const keys = Object.keys(record);
    if (keys.length === 1) return null;
  }
  const raw = stringifyDisplayValue(args);
  return raw ? fenced("json", raw) : null;
};

const fenced = (language: "json" | "text", content: string): string => {
  const longestRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
  );
  const marker = "`".repeat(Math.max(3, longestRun + 1));
  return `${marker}${language}\n${content}\n${marker}`;
};

const toolStatusText: Record<DisplayTool["status"], string> = {
  streaming_input: "Reading input...",
  waiting_approval: "Waiting for approval...",
  running: "Running...",
  completed: "Completed.",
  error: "Failed.",
  declined: "Declined.",
};

const collapseToolOutput = (output: string, expanded: boolean): string => {
  const lines = output.split(/\r?\n/);
  if (expanded || lines.length <= 24) return output;

  const head = lines.slice(0, 12);
  const tail = lines.slice(-4);
  const hidden = lines.length - head.length - tail.length;
  return [
    ...head,
    `… +${hidden} lines (${formatBinding("cube.transcript.toggle")} to view transcript)`,
    ...tail,
  ].join("\n");
};

const createToolMessage = (tool: DisplayTool, expanded = false): ChatMessage => {
  const theme = getTheme();
  const header = formatToolHeader(tool.name, tool.args);
  const extraArgs = formatToolExtraArgs(tool.args);
  const output =
    tool.shellOutput?.trimEnd() ||
    tool.partialResult?.trimEnd() ||
    stringifyDisplayValue(tool.result);
  const statusLine = theme.muted(toolStatusText[tool.status]);

  // FIX: `extraArgs` (the fenced JSON argument dump) and `output` (raw
  // shell/tool output) used to be pushed into `contentLines` completely
  // unstyled — no theme function wrapped them at all, so they rendered in
  // the terminal's bare default foreground. That's the other half of the
  // "tool output looks identical to user message text" bug: both were, in
  // fact, genuinely colorless, not just similarly colored. Wrapped in
  // `theme.muted` (one call spanning the embedded newlines — ANSI color
  // persists across `\n` until the trailing reset, same technique used in
  // code-highlight.ts) so the JSON/output body reads as de-emphasized
  // supporting detail under the `tool`-colored header, instead of invisible
  // styling that happens to fall back to whatever gray the terminal itself
  // defaults to.
  const contentLines: string[] = [header];
  if (extraArgs) contentLines.push(theme.muted(extraArgs));
  if (output) contentLines.push(theme.muted(collapseToolOutput(output, expanded)));
  contentLines.push(statusLine);

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
  content?: string | { parts?: unknown[] };
};

type SessionDisplayStateLike = {
  currentMessage: SessionMessageLike | null;
  isRunning: boolean;
  activeTools: Map<string, DisplayTool>;
  pendingApproval?: { toolCallId?: string } | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

const sessionToolStatus = (
  invocation: Record<string, unknown>,
): DisplayTool["status"] => {
  const state = typeof invocation.state === "string" ? invocation.state : "";
  if (state === "result" || state === "output-available") {
    return invocation.isError === true ? "error" : "completed";
  }
  if (state === "error" || state === "output-error") return "error";
  if (state === "declined" || state === "approval-rejected") return "declined";
  if (state.includes("approval")) return "waiting_approval";
  return "running";
};

const mapSessionMessage = (
  raw: SessionMessageLike,
  streaming: boolean,
  activeTools: Map<string, DisplayTool> = new Map(),
): ChatMessage[] => {
  const sourceMessageId = raw.id ?? `message-${Date.now()}`;
  const timestamp = raw.createdAt ? new Date(raw.createdAt) : new Date();
  if (typeof raw.content === "string") {
    return raw.content.trim()
      ? [{
          id: sourceMessageId,
          sourceMessageId,
          role: raw.role === "assistant" ? "assistant" : raw.role === "system" ? "system" : "user",
          content: raw.content,
          timestamp,
          status: streaming ? "streaming" : "done",
        }]
      : [];
  }

  const parts = raw.content?.parts ?? [];
  const messages: ChatMessage[] = [];
  let textIndex = 0;
  for (const part of parts) {
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
    if (record.type !== "tool-invocation") continue;
    const invocation = asRecord(record.toolInvocation);
    if (!invocation) continue;
    const toolCallId = typeof invocation.toolCallId === "string" ? invocation.toolCallId : undefined;
    const toolName = typeof invocation.toolName === "string" ? invocation.toolName : undefined;
    if (!toolCallId || !toolName) continue;
    const active = activeTools.get(toolCallId);
    const invocationStatus = sessionToolStatus(invocation);
    const invocationResult = invocation.result ?? invocation.output ?? invocation.error;
    const isInvocationFinal =
      invocationStatus === "completed" ||
      invocationStatus === "error" ||
      invocationStatus === "declined";

    const tool: DisplayTool = {
      id: toolCallId,
      name: toolName,
      args: invocation.args ?? invocation.input ?? active?.args ?? {},
      status: isInvocationFinal ? invocationStatus : (active?.status ?? invocationStatus),
      result: invocationResult ?? active?.result,
      partialResult: active?.partialResult,
      shellOutput: active?.shellOutput,
    };
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
  private toolOutputsExpanded = false;

  invalidate(): void {
    for (const entry of this.entries) {
      entry.cachedWidth = undefined;
      entry.cachedLines = undefined;
    }
  }

  setMessages(messages: ChatMessage[]) {
    this.entries = messages.map((message) => ({
      message: {
        ...(message.tool ? createToolMessage(message.tool, this.toolOutputsExpanded) : message),
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
        existing.message.status = msg.status ?? "done";
        existing.message.toolName = msg.toolName ?? existing.message.toolName;
        existing.message.tool = msg.tool ?? existing.message.tool;
        existing.cachedWidth = undefined;
        existing.cachedLines = undefined;
        return;
      }
    }
    if (msg.status === "streaming") {
      this.addMessage(msg);
      return;
    }
    this.addMessage(msg);
  }

  upsertTool(tool: DisplayTool) {
    this.upsertMessage(createToolMessage(tool, this.toolOutputsExpanded));
  }

  setSessionMessages(messages: readonly SessionMessageLike[]): void {
    this.setMessages(messages.flatMap((message) => mapSessionMessage(message, false)));
  }

  applySessionMessage(
    message: SessionMessageLike,
    streaming: boolean,
    activeTools: Map<string, DisplayTool> = new Map(),
  ): void {
    const mapped = mapSessionMessage(message, streaming, activeTools).map((item) =>
      item.tool
        ? {
            ...createToolMessage(item.tool, this.toolOutputsExpanded),
            sourceMessageId: item.sourceMessageId,
            timestamp: item.timestamp,
          }
        : item,
    );
    if (!message.id) {
      for (const item of mapped) this.upsertMessage(item);
      return;
    }

    const sourceId = message.id;
    const existingIndices = this.entries
      .map((entry, index) => entry.message.sourceMessageId === sourceId ? index : -1)
      .filter((index) => index >= 0);
    const insertAt = existingIndices.length > 0
      ? Math.min(...existingIndices)
      : this.entries.length;
    this.entries = this.entries.filter(
      (entry) => entry.message.sourceMessageId !== sourceId,
    );
    this.entries.splice(
      Math.min(insertAt, this.entries.length),
      0,
      ...mapped.map((item) => ({ message: item })),
    );
    this.invalidate();
  }

  applySessionDisplayState(state: SessionDisplayStateLike): void {
    const activeTools = new Map<string, DisplayTool>();
    for (const [toolCallId, tool] of state.activeTools) {
      activeTools.set(toolCallId, {
        ...tool,
        id: tool.id || toolCallId,
        status:
          state.pendingApproval?.toolCallId === toolCallId
            ? "waiting_approval"
            : tool.status,
      });
    }

    if (state.currentMessage) {
      this.applySessionMessage(state.currentMessage, state.isRunning, activeTools);
      const allRenderedToolIds = new Set(
        this.getMessages()
          .filter((message) => message.tool)
          .map((message) => message.tool!.id),
      );
      for (const [toolCallId, tool] of activeTools) {
        if (!allRenderedToolIds.has(toolCallId)) {
          this.upsertTool(tool);
        }
      }
      return;
    }

    for (const [toolCallId, tool] of activeTools) {
      this.upsertTool(tool);
    }
  }

  toggleToolOutput(): boolean {
    this.toolOutputsExpanded = !this.toolOutputsExpanded;
    for (const entry of this.entries) {
      if (!entry.message.tool) continue;
      const sourceMessageId = entry.message.sourceMessageId;
      const timestamp = entry.message.timestamp;
      entry.message = {
        ...createToolMessage(entry.message.tool, this.toolOutputsExpanded),
        sourceMessageId,
        timestamp,
      };
      entry.cachedLines = undefined;
      entry.cachedWidth = undefined;
    }
    return this.toolOutputsExpanded;
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
    const theme = getTheme();
    switch (msg.role) {
      case "user":
        return theme.user("  ❯ ");
      case "assistant":
        return theme.assistant("  ❖ ");
      case "system":
        return theme.system("  ❖ ");
      case "tool":
        return theme.tool("  ❖ ");
    }
  }

  private contentColorFor(role: MessageRole): (text: string) => string {
    const theme = getTheme();
    switch (role) {
      case "user":
        return theme.user;
      case "system":
        return theme.system;
      default:
        return theme.assistant;
    }
  }

  private renderMessage(entry: CachedEntry, width: number): string[] {
    const theme = getTheme();
    const availableWidth = Math.max(width, 20);
    const msg = entry.message;
    const prefix = this.formatRolePrefix(msg);
    const prefixWidth = visibleWidth(prefix);
    const indent = " ".repeat(prefixWidth);
    const contentWidth = Math.max(1, availableWidth - prefixWidth);
    const lines: string[] = [];

    if (msg.role === "assistant" && msg.status !== "streaming") {
      const markdown = new Markdown(
        msg.content,
        0,
        0,
        createMarkdownTheme(),
        { color: theme.assistant },
      );
      const renderedLines = markdown.render(contentWidth);
      renderedLines.forEach((line, index) => {
        const combined = `${index === 0 ? prefix : indent}${line}`;
        lines.push(truncateToWidth(combined, availableWidth));
      });
      lines.push("");
      return lines;
    }

    if (msg.role === "assistant") {
      const contentLines = msg.content.split(/\r?\n/);
      for (let index = 0; index < contentLines.length; index++) {
        const wrapped = wrapTextWithAnsi(
          theme.assistant(contentLines[index]),
          contentWidth,
        );
        if (wrapped.length === 0) {
          lines.push(index === 0 ? truncateToWidth(prefix, availableWidth) : "");
        } else {
          wrapped.forEach((wLine, wIdx) => {
            const linePrefix = index === 0 && wIdx === 0 ? prefix : indent;
            lines.push(truncateToWidth(`${linePrefix}${wLine}`, availableWidth));
          });
        }
      }
      lines.push("");
      return lines;
    }

    if (msg.role === "tool") {
      const contentLines = msg.content.split(/\r?\n/);
      if (contentLines.length > 0) {
        const firstLineWrapped = wrapTextWithAnsi(
          contentLines[0],
          contentWidth,
        );
        if (firstLineWrapped.length === 0) {
          lines.push(truncateToWidth(prefix, availableWidth));
        } else {
          firstLineWrapped.forEach((wLine, wIdx) => {
            const linePrefix = wIdx === 0 ? prefix : indent;
            lines.push(truncateToWidth(`${linePrefix}${wLine}`, availableWidth));
          });
        }
        for (let i = 1; i < contentLines.length; i++) {
          const restWrapped = wrapTextWithAnsi(
            contentLines[i],
            contentWidth,
          );
          for (const wLine of restWrapped) {
            lines.push(truncateToWidth(`${indent}${wLine}`, availableWidth));
          }
        }
      }
      lines.push("");
      return lines;
    }

    // Fallback: user / system messages.
    const contentLines = msg.content.split(/\r?\n/);
    const color = this.contentColorFor(msg.role);
    if (contentLines.length > 0) {
      const firstLineWrapped = wrapTextWithAnsi(
        color(contentLines[0]),
        contentWidth,
      );
      if (firstLineWrapped.length === 0) {
        lines.push(truncateToWidth(prefix, availableWidth));
      } else {
        firstLineWrapped.forEach((wLine, wIdx) => {
          const linePrefix = wIdx === 0 ? prefix : indent;
          lines.push(truncateToWidth(`${linePrefix}${wLine}`, availableWidth));
        });
      }
      for (let i = 1; i < contentLines.length; i++) {
        const restWrapped = wrapTextWithAnsi(
          color(contentLines[i]),
          contentWidth,
        );
        for (const wLine of restWrapped) {
          lines.push(truncateToWidth(`${indent}${wLine}`, availableWidth));
        }
      }
    }
    lines.push("");
    return lines;
  }

  render(width: number): string[] {
    if (this.entries.length === 0) {
      return [];
    }

    const availableWidth = Math.max(width, 20);
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