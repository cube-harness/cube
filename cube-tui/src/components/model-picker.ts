import {
  SelectList,
  Text,
  getKeybindings,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { GatewayId, ModelCatalog, ReasoningEffort } from "@cube/runtime";
import { formatBinding } from "../keybindings.js";
import { appTheme } from "../themes/app.theme.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";
import { KeyHint } from "./key-hint.js";
import { SearchBar } from "./search-bar.js";

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  none: "Disable reasoning",
  minimal: "Fast shallow reasoning",
  low: "Light thinking pass",
  medium: "Standard thinking effort",
  high: "Deep multi-step analysis",
  xhigh: "Extra high reasoning budget",
  max: "Maximum reasoning budget",
  default: "Provider default",
};

export type ModelSelectionResult = {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
};

export type ModelPickerOptions = {
  gatewayId: GatewayId;
  catalog: ModelCatalog;
  currentModelId?: string;
  currentReasoningEffort?: ReasoningEffort;
  onSelect(result: ModelSelectionResult): void;
  onCancel(): void;
};

export class ModelPickerComponent implements Component, Focusable {
  private hasFocus = true;
  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.searchBar.focused = value && this.step === "model";
  }
  private step: "model" | "reasoning" = "model";
  private selectedModelId?: string;
  private readonly models;
  private readonly title: Text;
  private readonly searchBar = new SearchBar();
  private readonly modelList: SelectList;
  private reasoningList?: SelectList;
  private readonly hint: KeyHint;

  constructor(private readonly options: ModelPickerOptions) {
    const provider = options.gatewayId.slice(options.gatewayId.indexOf("/") + 1);
    this.models = [...(options.catalog.providers[provider]?.models ?? [])].sort(
      (left, right) =>
        Number(right.modelId === options.currentModelId) -
        Number(left.modelId === options.currentModelId),
    );
    this.title = new Text(appTheme.ui.text.bold("Select Model [" + options.gatewayId + "]"), 0, 0);
    this.modelList = new SelectList(
      this.models.map((model) => ({
        value: model.modelId,
        label: model.modelId + (model.modelId === options.currentModelId ? " (Current)" : ""),
      })),
      Math.min(10, Math.max(3, this.models.length)),
      createSelectListTheme(),
    );
    this.modelList.onSelect = ({ value }) => {
      const model = this.models.find((item) => item.modelId === value);
      if (model?.reasoning_efforts?.length)
        this.showReasoning(model.modelId, model.reasoning_efforts);
      else options.onSelect({ modelId: value });
    };
    this.modelList.onCancel = () => this.cancel();
    this.hint = new KeyHint([
      {
        key: formatBinding("tui.select.up") + "/" + formatBinding("tui.select.down"),
        label: "Navigate",
      },
      { key: "Type", label: "Search" },
      { key: formatBinding("tui.select.confirm"), label: "Select" },
      { key: formatBinding("tui.select.cancel"), label: "Cancel" },
    ]);
  }

  private showReasoning(modelId: string, efforts: string[]): void {
    this.step = "reasoning";
    this.focused = this.hasFocus;
    this.selectedModelId = modelId;
    this.searchBar.clear();
    this.title.setText(appTheme.ui.text.bold("Select Reasoning Effort [" + modelId + "]"));
    this.reasoningList = new SelectList(
      efforts.map((effort) => ({
        value: effort,
        label:
          effort +
          (modelId === this.options.currentModelId && effort === this.options.currentReasoningEffort
            ? " (Current)"
            : ""),
        description: EFFORT_DESCRIPTIONS[effort] ?? effort + " level",
      })),
      Math.min(8, Math.max(3, efforts.length)),
      createSelectListTheme(),
    );
    this.reasoningList.onSelect = ({ value }) =>
      this.options.onSelect({ modelId, reasoningEffort: value as ReasoningEffort });
    this.reasoningList.onCancel = () => this.cancel();
  }

  private cancel(): void {
    if (this.searchBar.getQuery()) {
      this.searchBar.clear();
      this.modelList.setFilter("");
    } else if (this.step === "reasoning") {
      this.step = "model";
      this.focused = this.hasFocus;
      this.selectedModelId = undefined;
      this.title.setText(appTheme.ui.text.bold("Select Model [" + this.options.gatewayId + "]"));
    } else {
      this.options.onCancel();
    }
  }

  render(width: number): string[] {
    return [
      ...this.title.render(width),
      ...(this.step === "model"
        ? this.searchBar.render(width)
        : [truncateToWidth(appTheme.ui.muted("Model: " + (this.selectedModelId ?? "")), width)]),
      "",
      ...(this.step === "reasoning" && this.reasoningList
        ? this.reasoningList.render(width)
        : this.modelList.render(width)),
      "",
      ...this.hint.render(width),
    ];
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    const bindings = [
      "tui.select.up",
      "tui.select.down",
      "tui.select.pageUp",
      "tui.select.pageDown",
      "tui.select.confirm",
      "tui.select.cancel",
    ] as const;
    if (bindings.some((binding) => keys.matches(data, binding))) {
      (this.step === "reasoning" ? this.reasoningList : this.modelList)?.handleInput(data);
      return;
    }
    if (this.step === "model") {
      this.searchBar.handleInput(data);
      this.modelList.setFilter(this.searchBar.getQuery().trim());
    }
  }

  invalidate(): void {
    this.title.invalidate();
    this.searchBar.invalidate();
    this.modelList.invalidate();
    this.reasoningList?.invalidate();
    this.hint.invalidate();
  }
}
