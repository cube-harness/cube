import {
  SelectList,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";
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

  // 2. Check for `pnpm/npm/yarn/bun exec/run <tool>`
  const execMatch = trimmed.match(
    /^(?:pnpm|npm|yarn|bun)\s+(?:exec|run)\s+\S+/i,
  );
  if (execMatch) return execMatch[0];

  // 3. Flags splitting: find first option flag starting with `--`
  const tokens = trimmed.split(/\s+/);
  const firstFlagIdx = tokens.findIndex(
    (t, idx) => idx >= 1 && t.startsWith("--"),
  );
  if (firstFlagIdx >= 1) {
    if (tokens[firstFlagIdx] === "--filter" && tokens.length > firstFlagIdx + 2) {
      if (tokens[firstFlagIdx + 2] === "exec" && tokens.length > firstFlagIdx + 3) {
        return tokens.slice(0, firstFlagIdx + 4).join(" ");
      }
      return tokens.slice(0, firstFlagIdx + 2).join(" ");
    }
    return tokens.slice(0, firstFlagIdx).join(" ");
  }

  // 4. Common CLI tools: git, docker, cargo, go, etc.
  if (
    tokens.length >= 2 &&
    ["git", "docker", "cargo", "go", "npm", "pnpm", "yarn", "bun", "npx"].includes(
      tokens[0]!.toLowerCase(),
    )
  ) {
    return tokens.slice(0, Math.min(tokens.length, 3)).join(" ");
  }

  if (tokens.length <= 2) return trimmed;
  return tokens.slice(0, 2).join(" ");
};

export const parseApprovalArgs = (
  args: unknown,
  defaultReason?: string,
  defaultEnv?: string,
): ParsedApprovalArgs => {
  if (args === null || args === undefined) {
    return {
      reason: defaultReason,
      environment: defaultEnv || "local",
      rawLines: [],
    };
  }

  if (typeof args === "string") {
    return {
      command: args,
      reason: defaultReason,
      environment: defaultEnv || "local",
      rawLines: args.split(/\r?\n/),
    };
  }

  if (typeof args === "object") {
    const obj = args as Record<string, unknown>;
    const command =
      typeof obj.command === "string"
        ? obj.command
        : typeof obj.cmd === "string"
          ? obj.cmd
          : typeof obj.script === "string"
            ? obj.script
            : undefined;

    const reason =
      typeof obj.reason === "string"
        ? obj.reason
        : typeof obj.explanation === "string"
          ? obj.explanation
          : typeof obj.description === "string"
            ? obj.description
            : defaultReason;

    const environment =
      typeof obj.environment === "string"
        ? obj.environment
        : typeof obj.env === "string"
          ? obj.env
          : defaultEnv || "local";

    let rawLines: string[] = [];
    try {
      rawLines = (JSON.stringify(args, null, 2) ?? String(args)).split(/\r?\n/);
    } catch {
      rawLines = [String(args)];
    }

    return {
      command,
      reason,
      environment,
      rawLines,
    };
  }

  return {
    reason: defaultReason,
    environment: defaultEnv || "local",
    rawLines: [String(args)],
  };
};

export class ApprovalPicker implements Component, Focusable {
  private readonly list: SelectList;
  private readonly parsed: ParsedApprovalArgs;
  private isFocused = false;

  constructor(private readonly options: ApprovalPickerOptions) {
    this.parsed = parseApprovalArgs(
      this.options.args,
      this.options.reason,
      this.options.environment,
    );

    const prefix = this.parsed.command
      ? extractCommandPrefix(this.parsed.command)
      : undefined;

    const items = [
      {
        value: "approve",
        label: `1. Yes, proceed (${formatBinding("cube.approval.approve")})`,
      },
      {
        value: "approve_prefix",
        label: prefix
          ? `2. Yes, and don't ask again for commands that start with \`${prefix}\` (${formatBinding("cube.approval.approvePrefix")})`
          : `2. Yes, and don't ask again for tool \`${this.options.toolName}\` (${formatBinding("cube.approval.approvePrefix")})`,
      },
      {
        value: "decline",
        label: `3. No, and tell Codex what to do differently (${formatBinding("cube.approval.decline")}/${formatBinding("tui.select.cancel")})`,
      },
    ];

    this.list = new SelectList(items, 3, createSelectListTheme());
    this.list.onSelect = (item) =>
      this.options.onDecision(item.value as ToolApprovalDecision);
    this.list.onCancel = () => this.options.onDecision("decline");
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
  }

  handleInput(data: string): void {
    if (matchesBinding(data, "cube.app.exit")) {
      this.options.onDecision("decline");
      return;
    }
    if (matchesBinding(data, "cube.approval.approve")) {
      this.options.onDecision("approve");
      return;
    }
    if (matchesBinding(data, "cube.approval.approvePrefix")) {
      this.options.onDecision("approve_prefix");
      return;
    }
    if (matchesBinding(data, "cube.approval.decline")) {
      this.options.onDecision("decline");
      return;
    }

    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const theme = getTheme();
    const lines: string[] = [];

    lines.push("");
    if (this.parsed.command) {
      lines.push(theme.primary.bold("Would you like to run the following command?"));
      lines.push("");
      lines.push(
        `  ${theme.muted("Environment:")} ${theme.assistant(this.parsed.environment || "local")}`,
      );
      if (this.parsed.reason) {
        lines.push("");
        lines.push(
          `  ${theme.muted("Reason:")} ${theme.assistant(this.parsed.reason)}`,
        );
      }
      lines.push("");
      lines.push(`  ${theme.secondary("$")} ${theme.codeAccent(this.parsed.command)}`);
    } else {
      lines.push(
        theme.primary.bold(
          `Would you like to run the tool: ${this.options.toolName}?`,
        ),
      );
      if (this.parsed.environment) {
        lines.push(
          `  ${theme.muted("Environment:")} ${theme.assistant(this.parsed.environment)}`,
        );
      }
      if (this.parsed.reason) {
        lines.push(
          `  ${theme.muted("Reason:")} ${theme.assistant(this.parsed.reason)}`,
        );
      }
      if (this.parsed.rawLines.length > 0) {
        lines.push("");
        for (const rawLine of this.parsed.rawLines) {
          lines.push(`  ${theme.tool(rawLine)}`);
        }
      }
    }

    lines.push("");
    lines.push(...this.list.render(width));
    lines.push("");

    return lines.map((line) => truncateToWidth(line, width));
  }
}
