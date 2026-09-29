import {
  Input,
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { KeyHint } from "./key-hint.js";
import { Markdown } from "./markdown.js";
import { formatBinding, matchesBinding } from "../keybindings.js";
import { appTheme } from "../themes/app.theme.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";

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

type QuestionOption = {
  label: string;
  description?: string;
};

type QuestionPayload = {
  question: string;
  options?: QuestionOption[];
  multiple?: boolean;
  selectionMode?: "single_select" | "multi_select";
};

const normalizeQuestion = (value: unknown): QuestionPayload => {
  const record = asRecord(value) ?? {};
  const options = Array.isArray(record.options)
    ? record.options.flatMap((option) => {
        if (typeof option !== "object" || option === null) return [];
        const item = option as Record<string, unknown>;
        if (typeof item.label !== "string" || !item.label.trim()) return [];
        return [
          {
            label: item.label,
            ...(typeof item.description === "string" ? { description: item.description } : {}),
          },
        ];
      })
    : undefined;
  const multiple = record.multiple === true || record.selectionMode === "multi_select";

  return {
    question:
      typeof record.question === "string" && record.question.trim()
        ? record.question
        : "The agent is waiting for your input.",
    ...(options?.length ? { options } : {}),
    ...(options?.length ? { multiple } : {}),
  };
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
  private readonly question?: QuestionPayload;
  private focus: "options" | "input" = "input";
  private selectedIndex = 0;
  private readonly selected = new Set<number>();
  private readonly hint = new KeyHint();
  private readonly decision?: SelectList;
  private readonly input = new Input();
  private readonly planMarkdown?: Markdown;
  private mode: "decision" | "feedback" | "generic" = "generic";
  private inputError?: string;

  constructor(private readonly options: ToolSuspensionPickerOptions) {
    const { request } = options;
    if (typeof asRecord(request.suspendPayload)?.question === "string") {
      this.question = normalizeQuestion(request.suspendPayload);
      this.focus = this.question.options?.length ? "options" : "input";
      this.input.onSubmit = (answer) => this.submitAnswer(answer);
      this.input.onEscape = () => options.onResolve({ kind: "cancel" });
      return;
    }

    if (request.toolName === "submit_plan") {
      this.mode = "decision";
      const payload = asRecord(request.suspendPayload) ?? {};
      const plan = typeof payload.plan === "string" ? payload.plan : undefined;
      if (plan) {
        this.planMarkdown = new Markdown(plan);
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
        this.input.focused = this.focused;
      };
      this.decision.onCancel = () => options.onResolve({ kind: "cancel" });
      this.input.onSubmit = (feedback) => {
        this.resolvePlan("rejected", feedback.trim());
      };
      return;
    }

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
    this.input.focused = value && this.mode !== "decision" && (!this.question || this.focus === "input");
  }

  handleInput(data: string): void {
    if (matchesBinding(data, "tui.select.cancel")) {
      if (this.mode === "feedback") {
        this.mode = "decision";
        this.input.focused = false;
      } else {
        this.options.onResolve({ kind: "cancel" });
      }
      return;
    }
    if (this.question) this.handleQuestionInput(data);
    else if (this.mode === "decision") this.decision?.handleInput(data);
    else this.input.handleInput(data);
  }

  invalidate(): void {
    this.hint.invalidate();
    this.decision?.invalidate();
    this.input.invalidate();
    this.planMarkdown?.invalidate();
  }

  render(width: number): string[] {
    if (this.question) return this.renderQuestion(width);

    this.hint.setHints([
      ...(this.mode === "decision" ? [{ key: formatBinding("tui.select.up") + "/" + formatBinding("tui.select.down"), label: "Navigate" }] : []),
      { key: formatBinding("tui.select.confirm"), label: this.mode === "decision" ? "Select" : "Submit" },
      { key: formatBinding("tui.select.cancel"), label: this.mode === "feedback" ? "Back" : "Cancel" },
    ]);
    const lines: string[] = [];
    if (this.options.request.toolName === "submit_plan") {
      const payload = asRecord(this.options.request.suspendPayload) ?? {};
      const title = typeof payload.title === "string" ? payload.title : undefined;
      const path = typeof payload.path === "string" ? payload.path : undefined;
      lines.push(appTheme.ui.text.bold("Review implementation plan"));
      if (title) lines.push(appTheme.ui.text(title));
      if (path) lines.push(appTheme.ui.muted(path));
      lines.push("");
      if (this.planMarkdown) {
        lines.push(
          ...this.planMarkdown.render(width),
          "",
        );
      }
      if (this.mode === "decision") {
        lines.push(...this.decision!.render(width));
      } else {
        lines.push(appTheme.ui.text.bold("What should change?"));
        lines.push(...this.input.render(width));
      }
      return [...lines.map((line) => truncateToWidth(line, width)), "", ...this.hint.render(width)];
    }

    lines.push(
      appTheme.ui.text.bold(`Input required: ${this.options.request.toolName}`),
      "",
    );
    const payloadText = formatPayload(this.options.request.suspendPayload);
    lines.push(
      ...wrapTextWithAnsi(payloadText, width).map((line) => appTheme.role.tool(line)),
      "",
    );
    if (this.options.request.resumeSchema) {
      lines.push(appTheme.ui.muted(`Resume schema: ${this.options.request.resumeSchema}`));
      lines.push("");
    }
    lines.push(...this.input.render(width));
    if (this.inputError) lines.push(appTheme.status.error(this.inputError));
    return [...lines.map((line) => truncateToWidth(line, width)), "", ...this.hint.render(width)];
  }

  private handleQuestionInput(data: string): void {
    const options = this.question!.options ?? [];

    if (this.focus === "input") {
      if (options.length > 0 && matchesBinding(data, "tui.select.up")) {
        this.focusOptions(options.length - 1);
      } else if (options.length > 0 && matchesBinding(data, "tui.select.down")) {
        this.focusOptions(0);
      } else {
        this.input.handleInput(data);
      }
      return;
    }

    if (matchesBinding(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? options.length - 1 : this.selectedIndex - 1;
    } else if (matchesBinding(data, "tui.select.down")) {
      if (this.selectedIndex === options.length - 1) {
        this.focusInput();
      } else {
        this.selectedIndex += 1;
      }
    } else if (this.question!.multiple && matchesBinding(data, "cube.askUser.toggle")) {
      if (this.selected.has(this.selectedIndex)) {
        this.selected.delete(this.selectedIndex);
      } else {
        this.selected.add(this.selectedIndex);
      }
    } else if (matchesBinding(data, "tui.select.confirm")) {
      if (this.question!.multiple) {
        this.submitSelected();
      } else {
        this.options.onResolve({ kind: "resume", resumeData: options[this.selectedIndex]!.label });
      }
    }
  }

  private renderQuestion(width: number): string[] {
    const contentWidth = width;
    const lines: string[] = [];
    lines.push(
      ...wrapTextWithAnsi(appTheme.ui.text.bold(this.question!.question), contentWidth).map((line) =>
        truncateToWidth(line, contentWidth),
      ),
      "",
    );

    const options = this.question!.options ?? [];
    for (let index = 0; index < options.length; index++) {
      const option = options[index]!;
      const active = this.focus === "options" && index === this.selectedIndex;
      const cursor = active ? "❯" : " ";
      const checked = this.question!.multiple ? `${this.selected.has(index) ? "[x]" : "[ ]"} ` : "";
      lines.push(
        ...this.renderChoice(
          `${cursor} ${checked}${option.label}`,
          option.description,
          active,
          contentWidth,
        ),
      );
    }

    lines.push("");
    this.input.focused = this.focused && this.focus === "input";

    const isInputFocused = this.focus === "input";
    const prefix = isInputFocused ? appTheme.ui.primary.bold("❯ ") : "  ";

    if (this.input.getValue().length === 0) {
      const placeholderText = isInputFocused
        ? appTheme.ui.text("Write your answer...")
        : appTheme.ui.muted("Write your answer...");
      lines.push(`${prefix}${placeholderText}`);
    } else {
      lines.push(
        ...this.input
          .render(contentWidth)
          .map((line) => (line.startsWith("> ") ? `${prefix}${line.slice(2)}` : line)),
      );
    }
    lines.push("");

    this.hint.setHints([
      ...(this.question!.multiple ? [{ key: formatBinding("cube.askUser.toggle"), label: "Toggle" }] : []),
      { key: formatBinding("tui.select.up") + "/" + formatBinding("tui.select.down"), label: "Navigate" },
      { key: formatBinding("tui.select.confirm"), label: this.question!.multiple ? "Submit" : "Select/Submit" },
      { key: formatBinding("tui.select.cancel"), label: "Cancel" },
    ]);
    return [...lines.map((line) => truncateToWidth(line, width)), ...this.hint.render(width)];
  }

  private focusInput(): void {
    this.focus = "input";
    this.input.focused = this.focused;
  }

  private focusOptions(index: number): void {
    this.focus = "options";
    this.selectedIndex = index;
    this.input.focused = false;
  }

  private submitAnswer(answer: string): void {
    const trimmed = answer.trim();
    if (!this.question!.options?.length || !this.question!.multiple) {
      if (!trimmed) return;
      this.options.onResolve({ kind: "resume", resumeData: trimmed });
      return;
    }

    this.submitSelected(trimmed);
  }

  private submitSelected(customAnswer?: string): void {
    const options = this.question!.options ?? [];
    const answers = [
      ...options.filter((_, index) => this.selected.has(index)).map((option) => option.label),
      ...(customAnswer ? [customAnswer] : []),
    ];
    if (answers.length > 0) this.options.onResolve({ kind: "resume", resumeData: answers });
  }

  private renderChoice(
    label: string,
    description: string | undefined,
    active: boolean,
    width: number,
  ): string[] {
    const labelStyle = active ? appTheme.ui.primary.bold : appTheme.ui.text;
    const styledLabel = labelStyle(label);
    if (!description) return [truncateToWidth(styledLabel, width)];

    const gap = "  ";
    const labelWidth = visibleWidth(styledLabel);
    const descriptionWidth = Math.max(1, width - labelWidth - gap.length);
    const descriptionLines = wrapTextWithAnsi(appTheme.ui.muted(description), descriptionWidth);
    const first = `${styledLabel}${gap}${descriptionLines[0] ?? ""}`;
    const indent = " ".repeat(labelWidth + gap.length);
    return [
      truncateToWidth(first, width),
      ...descriptionLines.slice(1).map((line) => truncateToWidth(`${indent}${line}`, width)),
    ];
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
