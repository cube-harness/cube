// cube-tui/src/components/message-list.ts
import {
  Markdown,
  wrapTextWithAnsi,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";
import { createMarkdownTheme } from "../themes/pi-tui.theme.js";

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id?: string;
  role: MessageRole;
  content: string;
  timestamp?: Date;
  status?: "pending" | "streaming" | "done" | "error";
  toolName?: string;
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
  return `${theme.assistant(toolName)}${cmdPart ? theme.muted(cmdPart) : ""}`;
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

export class MessageList implements Component {
  private entries: CachedEntry[] = [];
  private scrollOffset: number = 0;
  private autoScroll: boolean = true;

  invalidate(): void {
    for (const entry of this.entries) {
      entry.cachedWidth = undefined;
      entry.cachedLines = undefined;
    }
  }

  setMessages(messages: ChatMessage[]) {
    this.entries = messages.map((message) => ({
      message: {
        ...message,
        timestamp: message.timestamp ?? new Date(),
      },
    }));
    this.scrollOffset = 0;
    this.scrollToBottom();
    this.invalidate();
  }

  clearMessages() {
    this.entries = [];
    this.scrollOffset = 0;
    this.invalidate();
  }

  addMessage(msg: ChatMessage | string) {
    const chatMsg: ChatMessage =
      typeof msg === "string"
        ? { role: "user", content: msg, timestamp: new Date() }
        : { ...msg, timestamp: msg.timestamp ?? new Date() };

    this.entries.push({ message: chatMsg });

    if (this.autoScroll) {
      this.scrollToBottom();
    }
  }

  upsertMessage(msg: ChatMessage) {
    if (msg.id) {
      const existing = this.entries.find((e) => e.message.id === msg.id);
      if (existing) {
        existing.message.content = msg.content;
        existing.message.status = msg.status ?? "streaming";
        existing.cachedWidth = undefined;
        existing.cachedLines = undefined;
        return;
      }
    }
    this.addMessage(msg);
  }

  upsertTool(tool: DisplayTool) {
    const theme = getTheme();
    const header = formatToolHeader(tool.name, tool.args);
    const extraArgs = formatToolExtraArgs(tool.args);
    const output =
      tool.shellOutput?.trimEnd() ||
      tool.partialResult?.trimEnd() ||
      stringifyDisplayValue(tool.result);

    const statusLine = theme.muted(toolStatusText[tool.status]);

    const contentLines: string[] = [header];
    if (extraArgs) contentLines.push(extraArgs);
    if (output) contentLines.push(output);
    contentLines.push(statusLine);

    this.upsertMessage({
      id: tool.id,
      role: "tool",
      toolName: tool.name,
      content: contentLines.join("\n"),
      status:
        tool.status === "error" || tool.status === "declined"
          ? "error"
          : tool.status === "completed"
          ? "done"
          : "pending",
    });
  }

  updateLastMessage(
    content: string,
    status: "streaming" | "done" | "error" = "streaming",
  ) {
    if (this.entries.length === 0) return;
    const last = this.entries[this.entries.length - 1];
    last.message.content = content;
    last.message.status = status;
    last.cachedWidth = undefined;
    last.cachedLines = undefined;

    if (this.autoScroll) {
      this.scrollToBottom();
    }
  }

  updateMessage(
    id: string,
    content: string,
    status: "pending" | "streaming" | "done" | "error" = "streaming",
  ) {
    const entry = this.entries.find((e) => e.message.id === id);
    if (!entry) return;
    entry.message.content = content;
    entry.message.status = status;
    entry.cachedWidth = undefined;
    entry.cachedLines = undefined;

    if (this.autoScroll) {
      this.scrollToBottom();
    }
  }

  clear() {
    this.entries = [];
    this.scrollOffset = 0;
    this.autoScroll = true;
  }

  scrollUp(lines: number = 1) {
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);
    this.autoScroll = false;
  }

  scrollDown(lines: number = 1) {
    this.scrollOffset += lines;
  }

  pageUp(pageSize: number = 10) {
    this.scrollUp(pageSize);
  }

  pageDown(pageSize: number = 10) {
    this.scrollDown(pageSize);
  }

  scrollToBottom() {
    this.scrollOffset = Infinity;
    this.autoScroll = true;
  }

  getMessages(): ChatMessage[] {
    return this.entries.map((e) => e.message);
  }

  private formatRolePrefix(msg: ChatMessage): string {
    const theme = getTheme();
    switch (msg.role) {
      case "user":
        return theme.user("> ");
      case "assistant":
        return theme.assistant("• ");
      case "system":
        return theme.warning("• ");
      case "tool":
        return theme.success("• ");
    }
  }

  private renderMessage(entry: CachedEntry, width: number): string[] {
    const theme = getTheme();
    const availableWidth = Math.max(width, 20);
    const msg = entry.message;
    const prefix = this.formatRolePrefix(msg);
    const lines: string[] = [];

    if (msg.role === "assistant") {
      const markdown = new Markdown(
        msg.content,
        0,
        0,
        createMarkdownTheme(),
        { color: theme.assistant },
      );
      const renderedLines = markdown.render(Math.max(1, availableWidth - 2));
      renderedLines.forEach((line, index) => {
        const combined = `${index === 0 ? prefix : "  "}${line}`;
        lines.push(truncateToWidth(combined, availableWidth));
      });
      lines.push("");
      return lines;
    }

    if (msg.role === "tool") {
      const contentLines = msg.content.split(/\r?\n/);
      if (contentLines.length > 0) {
        const firstLineWrapped = wrapTextWithAnsi(
          `${prefix}${contentLines[0]}`,
          availableWidth,
        );
        for (const wLine of firstLineWrapped) {
          lines.push(truncateToWidth(wLine, availableWidth));
        }
        for (let i = 1; i < contentLines.length; i++) {
          const restWrapped = wrapTextWithAnsi(
            `  ${contentLines[i]}`,
            availableWidth,
          );
          for (const wLine of restWrapped) {
            lines.push(truncateToWidth(wLine, availableWidth));
          }
        }
      }
      lines.push("");
      return lines;
    }

    const contentLines = msg.content.split(/\r?\n/);
    if (contentLines.length > 0) {
      const firstLineWrapped = wrapTextWithAnsi(
        `${prefix}${contentLines[0]}`,
        availableWidth,
      );
      for (const wLine of firstLineWrapped) {
        lines.push(truncateToWidth(wLine, availableWidth));
      }
      for (let i = 1; i < contentLines.length; i++) {
        const restWrapped = wrapTextWithAnsi(
          `  ${contentLines[i]}`,
          availableWidth,
        );
        for (const wLine of restWrapped) {
          lines.push(truncateToWidth(wLine, availableWidth));
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
