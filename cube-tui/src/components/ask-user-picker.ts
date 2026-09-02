import {
  Input,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { formatBinding, matchesBinding } from "../keybindings.js";
import { appTheme } from "../themes/app.theme.js";
import { renderPickerCard } from "./picker-card.js";

export type AskUserOption = {
  label: string;
  description?: string;
};

export type AskUserPayload = {
  question: string;
  options?: AskUserOption[];
  multiple?: boolean;
  /** Compatibility with suspensions created by Mastra's former built-in tool. */
  selectionMode?: "single_select" | "multi_select";
};

export type AskUserAnswer = string | string[];

export type AskUserPickerOptions = {
  payload: AskUserPayload;
  onAnswer: (answer: AskUserAnswer) => void;
  onCancel: () => void;
};

const normalizePayload = (value: unknown): AskUserPayload => {
  const record = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  const options = Array.isArray(record.options)
    ? record.options.flatMap((option) => {
        if (typeof option !== "object" || option === null) return [];
        const item = option as Record<string, unknown>;
        if (typeof item.label !== "string" || !item.label.trim()) return [];
        return [{
          label: item.label,
          ...(typeof item.description === "string"
            ? { description: item.description }
            : {}),
        }];
      })
    : undefined;
  const multiple = record.multiple === true || record.selectionMode === "multi_select";

  return {
    question: typeof record.question === "string" && record.question.trim()
      ? record.question
      : "The agent is waiting for your input.",
    ...(options?.length ? { options } : {}),
    ...(options?.length ? { multiple } : {}),
  };
};

export class AskUserPicker implements Component, Focusable {
  private _focused = true;
  private readonly payload: AskUserPayload;
  private readonly input = new Input();
  private focus: "options" | "input";
  private selectedIndex = 0;
  private readonly selected = new Set<number>();

  constructor(private readonly options: AskUserPickerOptions) {
    this.payload = normalizePayload(options.payload);
    this.focus = this.payload.options?.length ? "options" : "input";
    this.input.onSubmit = (answer) => this.submitInput(answer);
    this.input.onEscape = () => this.options.onCancel();
  }

  static fromUnknown(
    payload: unknown,
    callbacks: Pick<AskUserPickerOptions, "onAnswer" | "onCancel">,
  ): AskUserPicker {
    return new AskUserPicker({ payload: normalizePayload(payload), ...callbacks });
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.focus === "input";
  }

  handleInput(data: string): void {
    const options = this.payload.options ?? [];

    if (matchesBinding(data, "tui.select.cancel")) {
      this.options.onCancel();
      return;
    }

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
      this.selectedIndex = this.selectedIndex === 0
        ? options.length - 1
        : this.selectedIndex - 1;
    } else if (matchesBinding(data, "tui.select.down")) {
      if (this.selectedIndex === options.length - 1) {
        this.focusInput();
      } else {
        this.selectedIndex += 1;
      }
    } else if (this.payload.multiple && matchesBinding(data, "cube.askUser.toggle")) {
      if (this.selected.has(this.selectedIndex)) {
        this.selected.delete(this.selectedIndex);
      } else {
        this.selected.add(this.selectedIndex);
      }
    } else if (matchesBinding(data, "tui.select.confirm")) {
      if (this.payload.multiple) {
        this.submitSelected();
      } else {
        this.options.onAnswer(options[this.selectedIndex]!.label);
      }
    }
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 4);
    const lines: string[] = [""];
    lines.push(
      ...wrapTextWithAnsi(appTheme.ui.text.bold(this.payload.question), contentWidth)
        .map((line) => truncateToWidth(line, contentWidth)),
      "",
    );

    const options = this.payload.options ?? [];
    for (let index = 0; index < options.length; index++) {
      const option = options[index]!;
      const active = this.focus === "options" && index === this.selectedIndex;
      const cursor = active ? "❯" : " ";
      const checked = this.payload.multiple
        ? `${this.selected.has(index) ? "[x]" : "[ ]"} `
        : "";
      lines.push(...this.renderChoice(
        `${cursor} ${checked}${option.label}`,
        option.description,
        active,
        contentWidth,
      ));
    }

    lines.push("");
    lines.push(appTheme.ui.muted("Write your answer..."));
    this.input.focused = this.focused && this.focus === "input";
    lines.push(...this.input.render(contentWidth));
    lines.push("");
    const controls = this.payload.multiple
      ? `${formatBinding("cube.askUser.toggle")}: Toggle • ${formatBinding("tui.select.up")}/${formatBinding("tui.select.down")}: Navigate • ${formatBinding("tui.select.confirm")}: Submit • ${formatBinding("tui.select.cancel")}: Cancel`
      : `${formatBinding("tui.select.up")}/${formatBinding("tui.select.down")}: Navigate • ${formatBinding("tui.select.confirm")}: Select/Submit • ${formatBinding("tui.select.cancel")}: Cancel`;
    lines.push(appTheme.ui.muted(controls), "");
    return renderPickerCard(lines, width);
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

  private submitInput(answer: string): void {
    const trimmed = answer.trim();
    if (!this.payload.options?.length || !this.payload.multiple) {
      if (!trimmed) return;
      this.options.onAnswer(trimmed);
      return;
    }

    this.submitSelected(trimmed);
  }

  private submitSelected(customAnswer?: string): void {
    const options = this.payload.options ?? [];
    const answers = [
      ...options
        .filter((_, index) => this.selected.has(index))
        .map((option) => option.label),
      ...(customAnswer ? [customAnswer] : []),
    ];
    if (answers.length > 0) this.options.onAnswer(answers);
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
    const descriptionLines = wrapTextWithAnsi(
      appTheme.ui.muted(description),
      descriptionWidth,
    );
    const first = `${styledLabel}${gap}${descriptionLines[0] ?? ""}`;
    const indent = " ".repeat(labelWidth + gap.length);
    return [
      truncateToWidth(first, width),
      ...descriptionLines.slice(1).map((line) => truncateToWidth(`${indent}${line}`, width)),
    ];
  }
}
