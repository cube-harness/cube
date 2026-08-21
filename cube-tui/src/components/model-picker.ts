import {
  Container,
  SelectList,
  Text,
  Key,
  fuzzyFilter,
  matchesKey,
  type Component,
  type Focusable,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";
import { KeyHint } from "./key-hint.js";
import { SearchBar } from "./search-bar.js";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelItem {
  modelId: string;
  name: string;
  provider: string;
  family?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  limit?: {
    context: number;
    output: number;
  };
}

export interface ProviderGroup {
  id: string;
  name: string;
  models: ModelItem[];
}

export interface ModelSelectionResult {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ModelPickerOptions {
  providers: ProviderGroup[];
  currentModelId?: string;
  currentReasoningEffort?: ReasoningEffort;
  onSelect: (result: ModelSelectionResult) => void;
  onCancel: () => void;
}

export class ModelPickerComponent extends Container implements Component, Focusable {
  focused = true;
  private step: "provider" | "model" | "reasoning" = "provider";
  private selectedProvider?: ProviderGroup;
  private selectedModel?: ModelItem;

  private readonly providerList: SelectList;
  private modelList?: SelectList;
  private reasoningList?: SelectList;

  private readonly title: Text;
  private readonly searchBar: SearchBar;
  private readonly hint: KeyHint;

  constructor(private readonly options: ModelPickerOptions) {
    super();
    const theme = getTheme();

    this.title = new Text(theme.primary.bold("Select AI Provider"), 0, 0);
    this.searchBar = new SearchBar();

    const providerItems: SelectItem[] = options.providers.map((p) => ({
      value: p.id,
      label: `${p.name} (${p.models.length} models)`,
      description: undefined,
    }));

    this.providerList = new SelectList(
      providerItems,
      Math.min(10, Math.max(3, providerItems.length)),
      createSelectListTheme(),
    );

    this.providerList.onSelect = (item) => {
      const provider = options.providers.find((p) => p.id === item.value);
      if (provider) {
        this.switchToModelStep(provider);
      }
    };

    this.providerList.onCancel = () => {
      options.onCancel();
    };

    this.hint = new KeyHint([
      { key: "↑/↓", label: "Navigate" },
      { key: "Type", label: "Search" },
      { key: "Enter", label: "Select Provider" },
      { key: "Esc", label: "Cancel" },
    ]);

    this.addChild(this.title);
    this.addChild(this.searchBar);
    this.addChild(this.hint);
  }

  private applySearchFilter(): void {
    const query = this.searchBar.getQuery().trim();
    if (this.step === "provider") {
      this.providerList.setFilter(query);
    } else if (this.step === "model" && this.modelList) {
      this.modelList.setFilter(query);
    }
  }

  private switchToModelStep(provider: ProviderGroup): void {
    const theme = getTheme();
    this.step = "model";
    this.selectedProvider = provider;
    this.searchBar.clear();

    this.title.setText(theme.primary.bold(`Select Model [${provider.name}]`));

    const modelItems: SelectItem[] = provider.models.map((m) => {
      const isActive = m.modelId === this.options.currentModelId;
      const currentTag = isActive ? " (Current)" : "";

      return {
        value: m.modelId,
        label: `${m.modelId}${currentTag}`,
        description: undefined,
      };
    });

    this.modelList = new SelectList(
      modelItems,
      Math.min(10, Math.max(3, modelItems.length)),
      createSelectListTheme(),
    );

    this.modelList.onSelect = (item) => {
      const model = provider.models.find((m) => m.modelId === item.value);
      if (model?.reasoning) {
        this.switchToReasoningStep(model);
      } else {
        this.options.onSelect({ modelId: item.value });
      }
    };

    this.modelList.onCancel = () => {
      this.switchToProviderStep();
    };

    this.hint.setHints([
      { key: "↑/↓", label: "Navigate" },
      { key: "Type", label: "Search" },
      { key: "Enter", label: "Select Model" },
      { key: "Esc", label: "Back" },
    ]);
  }

  private switchToReasoningStep(model: ModelItem): void {
    const theme = getTheme();
    this.step = "reasoning";
    this.selectedModel = model;
    this.searchBar.clear();

    this.title.setText(
      theme.primary.bold(`Configure Reasoning Effort [${model.modelId}]`),
    );

    const currentEffort = this.options.currentReasoningEffort || "medium";
    const efforts: Array<{ value: ReasoningEffort; label: string; desc: string }> = [
      { value: "none", label: "none - Disable reasoning", desc: "No thinking tokens" },
      { value: "low", label: "low - Fast reasoning", desc: "Light thinking pass" },
      { value: "medium", label: "medium - Balanced reasoning", desc: "Standard thinking effort" },
      { value: "high", label: "high - Deep reasoning", desc: "Thorough multi-step analysis" },
      { value: "xhigh", label: "xhigh - Maximum reasoning", desc: "Full cognitive budget" },
    ];

    const items: SelectItem[] = efforts.map((e) => ({
      value: e.value,
      label: `${e.label}${e.value === currentEffort ? " (Current)" : ""}`,
      description: e.desc,
    }));

    this.reasoningList = new SelectList(
      items,
      5,
      createSelectListTheme(),
    );

    this.reasoningList.onSelect = (item) => {
      this.options.onSelect({
        modelId: model.modelId,
        reasoningEffort: item.value as ReasoningEffort,
      });
    };

    this.reasoningList.onCancel = () => {
      if (this.selectedProvider) {
        this.switchToModelStep(this.selectedProvider);
      } else {
        this.switchToProviderStep();
      }
    };

    this.hint.setHints([
      { key: "↑/↓", label: "Navigate" },
      { key: "Enter", label: "Confirm" },
      { key: "Esc", label: "Back" },
    ]);
  }

  private switchToProviderStep(): void {
    const theme = getTheme();
    this.step = "provider";
    this.selectedProvider = undefined;
    this.selectedModel = undefined;
    this.searchBar.clear();

    this.title.setText(theme.primary.bold("Select AI Provider"));
    this.providerList.setFilter("");

    this.hint.setHints([
      { key: "↑/↓", label: "Navigate" },
      { key: "Type", label: "Search" },
      { key: "Enter", label: "Select Provider" },
      { key: "Esc", label: "Cancel" },
    ]);
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // 1. Render Title
    lines.push(...this.title.render(width));

    // 2. Render Search Bar (only in provider and model steps)
    if (this.step !== "reasoning") {
      lines.push(...this.searchBar.render(width));
      lines.push("");
    } else {
      const theme = getTheme();
      lines.push(theme.muted("Select reasoning level:"));
      lines.push("");
    }

    // 3. Render Active Step List
    if (this.step === "reasoning" && this.reasoningList) {
      lines.push(...this.reasoningList.render(width));
    } else if (this.step === "model" && this.modelList) {
      lines.push(...this.modelList.render(width));
    } else {
      lines.push(...this.providerList.render(width));
    }

    lines.push("");

    // 4. Render Hint
    lines.push(...this.hint.render(width));

    return lines;
  }

  handleInput(data: string): void {
    // 1. Handle Escape
    if (matchesKey(data, Key.escape) || data === "\x1b" || data === "escape") {
      if (this.searchBar.getQuery().length > 0) {
        this.searchBar.clear();
        this.applySearchFilter();
        return;
      }

      if (this.step === "reasoning" && this.selectedProvider) {
        this.switchToModelStep(this.selectedProvider);
        return;
      }
      if (this.step === "model") {
        this.switchToProviderStep();
        return;
      }
      this.options.onCancel();
      return;
    }

    // 2. Handle Navigation / Action Keys
    if (
      matchesKey(data, Key.up) ||
      matchesKey(data, Key.down) ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.pageUp) ||
      matchesKey(data, Key.pageDown) ||
      data === "\x1b[A" ||
      data === "\x1b[B" ||
      data === "up" ||
      data === "down" ||
      data === "enter" ||
      data === "\r" ||
      data === "\n"
    ) {
      if (this.step === "reasoning" && this.reasoningList) {
        this.reasoningList.handleInput(data);
        return;
      }
      if (this.step === "model" && this.modelList) {
        this.modelList.handleInput(data);
        return;
      }
      if (this.step === "provider") {
        this.providerList.handleInput(data);
        return;
      }
    }

    // 3. Handle Backspace in Search
    if (
      matchesKey(data, Key.backspace) ||
      data === "\x7f" ||
      data === "\b" ||
      data === "backspace"
    ) {
      if (this.searchBar.getQuery().length > 0) {
        this.searchBar.backspace();
        this.applySearchFilter();
      }
      return;
    }

    // 4. Handle Text Typing for Search (single printable char)
    if (data.length === 1 && data >= " " && data <= "~" && this.step !== "reasoning") {
      this.searchBar.appendChar(data);
      this.applySearchFilter();
      return;
    }
  }
}
