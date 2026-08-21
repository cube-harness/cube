import {
  Container,
  SelectList,
  Text,
  Key,
  CURSOR_MARKER,
  matchesKey,
  type Component,
  type Focusable,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

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
  private searchQuery = "";

  private readonly providerList: SelectList;
  private modelList?: SelectList;
  private reasoningList?: SelectList;

  private readonly title: Text;
  private readonly searchDisplay: Text;
  private readonly hint: Text;

  constructor(private readonly options: ModelPickerOptions) {
    super();
    const theme = getTheme();

    this.title = new Text(theme.primary.bold("Select AI Provider"), 0, 0);
    this.searchDisplay = new Text(
      theme.muted("Search: ") +
        theme.muted("Type to filter...") +
        CURSOR_MARKER,
      0,
      0,
    );

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

    this.hint = new Text(
      theme.muted("↑/↓: Navigate • Type: Search • Enter: Select Provider • Esc: Cancel"),
      0,
      0,
    );

    this.addChild(this.title);
    this.addChild(this.searchDisplay);
    this.addChild(this.hint);
  }

  private updateSearchDisplay(): void {
    const theme = getTheme();
    const marker = this.focused ? CURSOR_MARKER : "";
    const queryText = this.searchQuery
      ? theme.primary.bold(this.searchQuery)
      : theme.muted("Type to filter...");
    this.searchDisplay.setText(
      theme.muted("Search: ") + queryText + marker,
    );
  }

  private switchToModelStep(provider: ProviderGroup): void {
    const theme = getTheme();
    this.step = "model";
    this.selectedProvider = provider;
    this.searchQuery = "";
    this.updateSearchDisplay();

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

    this.hint.setText(
      theme.muted("↑/↓: Navigate • Type: Search • Enter: Select Model • Esc: Back"),
    );
  }

  private switchToReasoningStep(model: ModelItem): void {
    const theme = getTheme();
    this.step = "reasoning";
    this.selectedModel = model;
    this.searchQuery = "";

    this.title.setText(
      theme.primary.bold(`Configure Reasoning Effort [${model.modelId}]`),
    );
    this.searchDisplay.setText(
      theme.muted("Select reasoning level:"),
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

    this.hint.setText(
      theme.muted("↑/↓: Navigate • Enter: Confirm • Esc: Back"),
    );
  }

  private switchToProviderStep(): void {
    const theme = getTheme();
    this.step = "provider";
    this.selectedProvider = undefined;
    this.selectedModel = undefined;
    this.searchQuery = "";
    this.updateSearchDisplay();

    this.title.setText(theme.primary.bold("Select AI Provider"));
    this.providerList.setFilter("");

    this.hint.setText(
      theme.muted("↑/↓: Navigate • Type: Search • Enter: Select Provider • Esc: Cancel"),
    );
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // 1. Render Title
    lines.push(...this.title.render(width));

    // 2. Render Search Bar (immediately under Title)
    lines.push(...this.searchDisplay.render(width));
    lines.push("");

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
      if (this.searchQuery.length > 0) {
        this.searchQuery = "";
        this.updateSearchDisplay();
        if (this.step === "model" && this.modelList) {
          this.modelList.setFilter("");
        } else if (this.step === "provider") {
          this.providerList.setFilter("");
        }
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
      if (this.searchQuery.length > 0) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.updateSearchDisplay();
        if (this.step === "model" && this.modelList) {
          this.modelList.setFilter(this.searchQuery);
        } else if (this.step === "provider") {
          this.providerList.setFilter(this.searchQuery);
        }
      }
      return;
    }

    // 4. Handle Text Typing for Search (single printable char)
    if (data.length === 1 && data >= " " && data <= "~" && this.step !== "reasoning") {
      this.searchQuery += data;
      this.updateSearchDisplay();
      if (this.step === "model" && this.modelList) {
        this.modelList.setFilter(this.searchQuery);
      } else if (this.step === "provider") {
        this.providerList.setFilter(this.searchQuery);
      }
      return;
    }
  }
}
