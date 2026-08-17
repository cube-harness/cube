import {
  Input,
  Key,
  SelectList,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";

export interface ModelPickerOptions {
  models: ModelCatalogItemView[];
  currentModel: string;
  warning?: string;
}

export interface ModelCatalogItemView {
  id: string;
  reasoningEfforts?: string[];
}

export class ModelPicker implements Component, Focusable {
  private readonly search = new Input();
  private readonly list: SelectList;
  private error?: string;
  private warning?: string;

  onSelect?: (modelId: string) => void;
  onCancel?: () => void;

  constructor(options: ModelPickerOptions) {
    this.warning = options.warning;
    const items = options.models.map((model) => ({
      value: model.id,
      label: model.id,
      description: model.id === options.currentModel ? "current" : undefined,
    }));
    this.list = new SelectList(items, 12, createSelectListTheme());
    this.list.setSelectedIndex(Math.max(
      0,
      items.findIndex((item) => item.value === options.currentModel),
    ));
    this.list.onSelect = (item) => this.onSelect?.(item.value);
    this.list.onCancel = () => this.onCancel?.();
  }

  get focused(): boolean {
    return this.search.focused;
  }

  set focused(value: boolean) {
    this.search.focused = value;
  }

  getSelectedModel(): string | null {
    return this.list.getSelectedItem()?.value ?? null;
  }

  setError(message?: string): void {
    this.error = message;
  }

  setWarning(message?: string): void {
    this.warning = message;
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.up) ||
      matchesKey(data, Key.down) ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c"))
    ) {
      this.list.handleInput(data);
      return;
    }

    this.search.handleInput(data);
    this.list.setFilter(this.search.getValue());
  }

  invalidate(): void {
    this.search.invalidate();
    this.list.invalidate();
  }

  render(width: number): string[] {
    const theme = getTheme();
    return [
      theme.primary("Select model"),
      ...this.search.render(width),
      ...(this.warning ? [theme.warning(this.warning)] : []),
      ...(this.error ? [theme.error(this.error)] : []),
      ...this.list.render(width),
      theme.muted("Type to filter • Enter select • Esc cancel"),
    ].map((line) => truncateToWidth(line, width));
  }
}
