import {
  Input,
  Markdown,
  SelectList,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { AskUserPicker } from "./ask-user-picker.js";
import { matchesBinding } from "../keybindings.js";
import { appTheme } from "../themes/app.theme.js";
import {
  createMarkdownTheme,
  createSelectListTheme,
} from "../themes/pi-tui.theme.js";

export type ToolSuspensionRequest = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  suspendPayload: unknown;
  resumeSchema?: string;
};

export type ToolSuspensionResolution =
  | { kind: "resume"; resumeData: unknown }
  | { kind: "cancel" }
  | { kind: "dismissed" };

export type ToolSuspensionPickerOptions = {
  request: ToolSuspensionRequest;
  onResolve: (resolution: ToolSuspensionResolution) => void;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;

const isQuestionPayload = (value: unknown): boolean => {
  const record = asRecord(value);
  return typeof record?.question === "string";
};

const formatPayload = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export class ToolSuspensionPicker implements Component, Focusable {
  private _focused = true;
  private readonly askUser?: AskUserPicker;
  private readonly decision?: SelectList;
  private readonly input?: Input;
  private readonly planMarkdown?: Markdown;
  private mode: "decision" | "feedback" | "generic" = "generic";
  private inputError?: string;

  constructor(private readonly options: ToolSuspensionPickerOptions) {
    const { request } = options;
    if (isQuestionPayload(request.suspendPayload)) {
      this.askUser = AskUserPicker.fromUnknown(request.suspendPayload, {
        onAnswer: (resumeData) => options.onResolve({ kind: "resume", resumeData }),
        onCancel: () => options.onResolve({ kind: "cancel" }),
      });
      return;
    }

    if (request.toolName === "submit_plan") {
      this.mode = "decision";
      const payload = asRecord(request.suspendPayload) ?? {};
      const plan = typeof payload.plan === "string" ? payload.plan : undefined;
      if (plan) {
        this.planMarkdown = new Markdown(plan, 0, 0, createMarkdownTheme());
      }
      this.decision = new SelectList(
        [
          {
            value: "approved",
            label: "Approve plan",
            description: "Continue implementation using this plan.",
          },
          {
            value: "rejected",
            label: "Request changes",
            description: "Send revision feedback to the agent.",
          },
        ],
        2,
        createSelectListTheme(),
      );
      this.decision.onSelect = (item) => {
        if (item.value === "approved") {
          this.resolvePlan("approved");
          return;
        }
        this.mode = "feedback";
        this.input!.focused = this.focused;
      };
      this.decision.onCancel = () => options.onResolve({ kind: "cancel" });
      this.input = new Input();
      this.input.onSubmit = (feedback) => {
        this.resolvePlan("rejected", feedback.trim());
      };
      return;
    }

    this.input = new Input();
    this.input.onSubmit = (value) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      const schema = this.parseResumeSchema();
      const requiresJson = schema?.type === "object" || schema?.type === "array";
      try {
        const resumeData = JSON.parse(trimmed) as unknown;
        this.options.onResolve({ kind: "resume", resumeData });
      } catch {
        if (requiresJson) {
          this.inputError = "Enter valid JSON matching the resume schema.";
          return;
        }
        this.options.onResolve({ kind: "resume", resumeData: trimmed });
      }
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.askUser) this.askUser.focused = value;
    if (this.input) this.input.focused = value && this.mode !== "decision";
  }

  handleInput(data: string): void {
    if (this.askUser) {
      this.askUser.handleInput(data);
      return;
    }
    if (matchesBinding(data, "tui.select.cancel")) {
      if (this.mode === "feedback") {
        this.mode = "decision";
        if (this.input) this.input.focused = false;
      } else {
        this.options.onResolve({ kind: "cancel" });
      }
      return;
    }
    if (this.mode === "decision") this.decision?.handleInput(data);
    else this.input?.handleInput(data);
  }

  invalidate(): void {
    this.askUser?.invalidate();
    this.decision?.invalidate();
    this.input?.invalidate();
    this.planMarkdown?.invalidate();
  }

  render(width: number): string[] {
    if (this.askUser) return this.askUser.render(width);

    const contentWidth = Math.max(1, width - 4);
    const lines = [""];
    if (this.options.request.toolName === "submit_plan") {
      const payload = asRecord(this.options.request.suspendPayload) ?? {};
      const title = typeof payload.title === "string" ? payload.title : undefined;
      const path = typeof payload.path === "string" ? payload.path : undefined;
      lines.push(`  ${appTheme.ui.text.bold("Review implementation plan")}`);
      if (title) lines.push(`  ${appTheme.ui.text(title)}`);
      if (path) lines.push(`  ${appTheme.ui.muted(path)}`);
      lines.push("");
      if (this.planMarkdown) {
        lines.push(
          ...this.planMarkdown.render(contentWidth).map((line) => `  ${line}`),
          "",
        );
      }
      if (this.mode === "decision") {
        lines.push(...this.decision!.render(contentWidth).map((line) => `  ${line}`));
      } else {
        lines.push(`  ${appTheme.ui.text.bold("What should change?")}`);
        lines.push(...this.input!.render(contentWidth).map((line) => `  ${line}`));
      }
      return lines.map((line) => truncateToWidth(line, width));
    }

    lines.push(
      `  ${appTheme.ui.text.bold(`Input required: ${this.options.request.toolName}`)}`,
      "",
    );
    const payloadText = formatPayload(this.options.request.suspendPayload);
    lines.push(
      ...wrapTextWithAnsi(payloadText, contentWidth)
        .map((line) => `  ${appTheme.role.tool(line)}`),
      "",
    );
    if (this.options.request.resumeSchema) {
      lines.push(`  ${appTheme.ui.muted(`Resume schema: ${this.options.request.resumeSchema}`)}`);
      lines.push("");
    }
    lines.push(...this.input!.render(contentWidth).map((line) => `  ${line}`));
    if (this.inputError) lines.push(`  ${appTheme.status.error(this.inputError)}`);
    return lines.map((line) => truncateToWidth(line, width));
  }

  private resolvePlan(action: "approved" | "rejected", feedback?: string): void {
    const payload = asRecord(this.options.request.suspendPayload) ?? {};
    const resumeData: Record<string, unknown> = { action };
    for (const key of ["path", "title", "plan"] as const) {
      if (typeof payload[key] === "string") resumeData[key] = payload[key];
    }
    if (action === "rejected" && feedback) resumeData.feedback = feedback;
    this.options.onResolve({ kind: "resume", resumeData });
  }

  private parseResumeSchema(): Record<string, unknown> | null {
    if (!this.options.request.resumeSchema) return null;
    try {
      return asRecord(JSON.parse(this.options.request.resumeSchema));
    } catch {
      return null;
    }
  }
}
