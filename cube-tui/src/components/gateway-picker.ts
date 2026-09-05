import {
  SelectList,
  Text,
  type Component,
  type Focusable,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { GatewayChoice, GatewayId } from "@cube/runtime";
import { appTheme } from "../themes/app.theme.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";
import { KeyHint } from "./key-hint.js";

export type GatewayPickerSelection = { gatewayId: GatewayId; replace: boolean };

export type GatewayPickerOptions = {
  choices: GatewayChoice[];
  onSelect(selection: GatewayPickerSelection): void;
  onCancel(): void;
};

const groupLabels = {
  api_key: "API key",
  subscription: "Subscription",
  local: "Local",
};

const providerLabels: Record<string, string> = {
  google: "Google",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

export class GatewayPickerComponent implements Component, Focusable {
  focused = true;
  private step: "group" | "provider" | "saved" = "group";
  private group?: GatewayChoice["group"];
  private readonly title = new Text(appTheme.ui.text.bold("Select Gateway"), 0, 0);
  private list: SelectList;
  private readonly hint = new KeyHint([
    { key: "↑/↓", label: "Navigate" },
    { key: "Enter", label: "Select" },
    { key: "Esc", label: "Back" },
  ]);

  constructor(private readonly options: GatewayPickerOptions) {
    this.list = this.groupList();
  }

  private createList(
    items: SelectItem[],
    onSelect: (item: SelectItem) => void,
    onCancel: () => void,
  ): SelectList {
    const list = new SelectList(
      items,
      Math.min(8, Math.max(3, items.length)),
      createSelectListTheme(),
    );
    list.onSelect = onSelect;
    list.onCancel = onCancel;
    return list;
  }

  private groupList(): SelectList {
    return this.createList(
      [...new Set(this.options.choices.map((choice) => choice.group))].map((group) => ({
        value: group,
        label: groupLabels[group],
      })),
      ({ value }) => this.showProviders(value as GatewayChoice["group"]),
      () => this.options.onCancel(),
    );
  }

  private showProviders(group: GatewayChoice["group"]): void {
    this.step = "provider";
    this.group = group;
    this.title.setText(appTheme.ui.text.bold("Select Provider [" + groupLabels[group] + "]"));
    const choices = this.options.choices.filter((choice) => choice.group === group);
    this.list = this.createList(
      choices.map((choice) => ({
        value: choice.gatewayId,
        label: (providerLabels[choice.provider] ?? choice.provider) +
          (choice.configured ? " (Configured)" : ""),
      })),
      ({ value }) => {
        const choice = choices.find((item) => item.gatewayId === value);
        if (!choice) return;
        if (!choice.configured || choice.group === "subscription") {
          this.options.onSelect({ gatewayId: choice.gatewayId, replace: true });
        } else {
          this.showSavedChoice(choice);
        }
      },
      () => this.showGroups(),
    );
  }

  private showSavedChoice(choice: GatewayChoice): void {
    this.step = "saved";
    this.title.setText(
      appTheme.ui.text.bold("Configure " + (providerLabels[choice.provider] ?? choice.provider)),
    );
    this.list = this.createList(
      [
        { value: "saved", label: "Use saved configuration" },
        { value: "replace", label: "Configure another" },
      ],
      ({ value }) => this.options.onSelect({
        gatewayId: choice.gatewayId,
        replace: value === "replace",
      }),
      () => this.showProviders(choice.group),
    );
  }

  private showGroups(): void {
    this.step = "group";
    this.group = undefined;
    this.title.setText(appTheme.ui.text.bold("Select Gateway"));
    this.list = this.groupList();
  }

  render(width: number): string[] {
    return [
      ...this.title.render(width),
      ...(this.group && this.step === "saved"
        ? [appTheme.ui.muted(groupLabels[this.group])]
        : []),
      "",
      ...this.list.render(width),
      "",
      ...this.hint.render(width),
    ];
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.title.invalidate();
    this.list.invalidate();
    this.hint.invalidate();
  }
}
