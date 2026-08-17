import {
  SelectList,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";

export interface ApprovalPickerOptions {
  toolName: string;
  args: unknown;
}

const formatArgs = (args: unknown): string[] => {
  if (args === undefined || args === null) return [];
  if (typeof args === "string") return args.split(/\r?\n/);
  try {
    return (JSON.stringify(args, null, 2) ?? String(args)).split(/\r?\n/);
  } catch {
    return [String(args)];
  }
};

export class ApprovalPicker implements Component, Focusable {
  private readonly list: SelectList;
  private isFocused = false;

  onDecision?: (approved: boolean) => void;

  constructor(private readonly options: ApprovalPickerOptions) {
    this.list = new SelectList([
      { value: "approve", label: "Approve", description: "run this tool" },
      { value: "decline", label: "Decline", description: "do not run" },
    ], 2, createSelectListTheme());
    this.list.onSelect = (item) => this.onDecision?.(item.value === "approve");
    this.list.onCancel = () => this.onDecision?.(false);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const theme = getTheme();
    return [
      theme.warning(`Approval required: ${this.options.toolName}`),
      ...formatArgs(this.options.args).map((line) => theme.tool(line)),
      ...this.list.render(width),
      theme.muted("Up/Down select • Enter confirm • Esc decline"),
    ].map((line) => truncateToWidth(line, width));
  }
}
