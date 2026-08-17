import {
  SelectList,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";

export interface ModelConfigPickerOptions {
  modelId: string;
  efforts: string[];
  currentEffort?: string;
  warning?: string;
}

export class ModelConfigPicker implements Component, Focusable {
  private readonly list: SelectList;
  private isFocused = false;

  onSelect?: (effort: string) => void;
  onBack?: () => void;

  constructor(private readonly options: ModelConfigPickerOptions) {
    const items = options.efforts.map((effort) => ({
      value: effort,
      label: effort,
      description: effort === options.currentEffort ? "current" : undefined,
    }));
    this.list = new SelectList(items, 8, createSelectListTheme());
    this.list.setSelectedIndex(Math.max(
      0,
      items.findIndex(({ value }) => value === options.currentEffort),
    ));
    this.list.onSelect = (item) => this.onSelect?.(item.value);
    this.list.onCancel = () => this.onBack?.();
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
      theme.primary(`Configure ${this.options.modelId}`),
      ...(this.options.warning ? [theme.warning(this.options.warning)] : []),
      ...this.list.render(width),
      theme.muted("Enter select • Esc back"),
    ].map((line) => truncateToWidth(line, width));
  }
}
