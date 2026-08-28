import {
  SelectList,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";
import { formatBinding, matchesBinding } from "../keybindings.js";

export type ToolApprovalDecision = "approve" | "decline" | "approve_prefix";

export interface ApprovalPickerOptions {
  toolName: string;
  args: unknown;
  environment?: string;
  reason?: string;
  onDecision: (decision: ToolApprovalDecision) => void;
}

export interface ParsedApprovalArgs {
  command?: string;
  reason?: string;
  environment?: string;
  rawLines: string[];
}

/**
 * Extracts a representative command prefix for whitelist/remember option.
 * e.g. "pnpm --filter @cube/agent exec tsx --test ..." -> "pnpm --filter @cube/agent exec tsx"
 */
export const extractCommandPrefix = (cmd: string): string => {
  const trimmed = cmd.trim();
  if (!trimmed) return "";

  // 1. Check for `pnpm/yarn/bun --filter <target> exec <runner>`
  const pnpmExecMatch = trimmed.match(
    /^(?:pnpm|yarn|bun)\s+--filter\s+\S+\s+exec\s+\S+/i,
  );
  if (pnpmExecMatch) return pnpmExecMatch[0];

  // 2. Check for `npm/pnpm/yarn/bun run <script>`
  const runMatch = trimmed.match(
    /^(?:npm|pnpm|yarn|bun)\s+run\s+\S+/i,
  );
  if (runMatch) return runMatch[0];

  // 3. Check for `npm/pnpm/yarn/bun <script>`
  const scriptMatch = trimmed.match(
    /^(?:npm|pnpm|yarn|bun)\s+[a-zA-Z0-9_\-:]+/i,
  );
  if (scriptMatch) return scriptMatch[0];

  // 4. Fallback: match first 2 tokens (e.g. "git status", "docker compose") or single binary
  const tokens = trimmed.split(/\s+/);
  if (tokens.length >= 2) {
    return `${tokens[0]} ${tokens[1]}`;
  }
  return tokens[0];
};

export class ApprovalPicker implements Component, Focusable {
  focused = true;
  private readonly list: SelectList;
  private readonly parsed: ParsedApprovalArgs;

  constructor(private readonly options: ApprovalPickerOptions) {
    this.parsed = this.parseArgs(options.args);

    const approveKey = formatBinding("cube.approval.approve");
    const approvePrefixKey = formatBinding("cube.approval.approvePrefix");
    const declineKey = formatBinding("cube.approval.decline");

    const items = [
      {
        value: "approve",
        label: `Yes, proceed (${approveKey})`,
      },
    ];

    if (this.parsed.command) {
      const prefix = extractCommandPrefix(this.parsed.command);
      items.push({
        value: "approve_prefix",
        label: `Yes, and remember "${prefix}" (${approvePrefixKey})`,
      });
    }

    items.push({
      value: "decline",
      label: `No, cancel (${declineKey})`,
    });

    this.list = new SelectList(items, items.length, createSelectListTheme());

    this.list.onSelect = (item) => {
      this.options.onDecision(item.value as ToolApprovalDecision);
    };

    this.list.onCancel = () => {
      this.options.onDecision("decline");
    };
  }

  private parseArgs(args: unknown): ParsedApprovalArgs {
    if (!args) return { rawLines: [] };

    if (typeof args === "string") {
      try {
        const parsed = JSON.parse(args);
        return this.parseArgs(parsed);
      } catch {
        return {
          command: args,
          rawLines: [args],
        };
      }
    }

    if (typeof args === "object") {
      const obj = args as Record<string, unknown>;
      const command =
        typeof obj.CommandLine === "string"
          ? obj.CommandLine
          : typeof obj.command === "string"
            ? obj.command
            : typeof obj.cmd === "string"
              ? obj.cmd
              : undefined;

      const reason =
        typeof obj.toolAction === "string"
          ? obj.toolAction
          : typeof obj.reason === "string"
            ? obj.reason
            : typeof obj.description === "string"
              ? obj.description
              : undefined;

      const environment =
        typeof obj.environment === "string"
          ? obj.environment
          : typeof obj.env === "string"
            ? obj.env
            : typeof obj.Cwd === "string"
              ? obj.Cwd
              : undefined;

      const rawLines = Object.entries(obj).map(
        ([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`,
      );

      return {
        command,
        reason,
        environment,
        rawLines,
      };
    }

    return { rawLines: [String(args)] };
  }

  handleInput(data: string): void {
    if (matchesBinding(data, "cube.approval.approve")) {
      this.options.onDecision("approve");
      return;
    }

    if (matchesBinding(data, "cube.approval.approvePrefix")) {
      if (this.parsed.command) {
        this.options.onDecision("approve_prefix");
      } else {
        this.options.onDecision("approve");
      }
      return;
    }

    if (
      matchesBinding(data, "cube.approval.decline") ||
      matchesBinding(data, "tui.select.cancel")
    ) {
      this.options.onDecision("decline");
      return;
    }

    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];

    lines.push("");
    if (this.parsed.command) {
      lines.push(appTheme.ui.primary.bold("Would you like to run the following command?"));
      lines.push("");
      lines.push(
        `  ${appTheme.ui.muted("Environment:")} ${appTheme.role.assistant(this.parsed.environment || "local")}`,
      );
      if (this.parsed.reason) {
        lines.push("");
        lines.push(
          `  ${appTheme.ui.muted("Reason:")} ${appTheme.role.assistant(this.parsed.reason)}`,
        );
      }
      lines.push("");
      lines.push(`  ${appTheme.ui.secondary("$")} ${appTheme.markdown.codeInlineText(this.parsed.command)}`);
    } else {
      lines.push(
        appTheme.ui.primary.bold(
          `Would you like to run the tool: ${this.options.toolName}?`,
        ),
      );
      if (this.parsed.environment) {
        lines.push(
          `  ${appTheme.ui.muted("Environment:")} ${appTheme.role.assistant(this.parsed.environment)}`,
        );
      }
      if (this.parsed.reason) {
        lines.push(
          `  ${appTheme.ui.muted("Reason:")} ${appTheme.role.assistant(this.parsed.reason)}`,
        );
      }
      if (this.parsed.rawLines.length > 0) {
        lines.push("");
        for (const rawLine of this.parsed.rawLines) {
          lines.push(`  ${appTheme.role.tool(rawLine)}`);
        }
      }
    }

    lines.push("");
    lines.push(...this.list.render(width));
    lines.push("");

    return lines.map((line) => truncateToWidth(line, width));
  }
}
