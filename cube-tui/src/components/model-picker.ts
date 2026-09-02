import {
  Container,
  SelectList,
  Text,
  getKeybindings,
  type Component,
  type Focusable,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";
import { KeyHint } from "./key-hint.js";
import { SearchBar } from "./search-bar.js";
import { formatBinding } from "../keybindings.js";

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "default";

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  none: "Disable reasoning (no thinking tokens)",
  minimal: "Fast shallow reasoning",
  low: "Light thinking pass",
  medium: "Standard thinking effort",
  high: "Deep multi-step analysis",
  xhigh: "Extra high reasoning budget",
  max: "Maximum cognitive budget",
  default: "Provider default setting",
};

export interface ModelItem {
  modelId: string;
  name: string;
  family?: string;
  reasoning?: boolean;
  reasoning_efforts?: string[];
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

    this.title = new Text(appTheme.ui.text.bold("Select Provider"), 0, 0);
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
      this.handleCancel();
    };

    this.hint = new KeyHint([
      {
        key: `${formatBinding("tui.select.up")}/${formatBinding("tui.select.down")}`,
        label: "Navigate",
      },
      { key: "Type", label: "Search" },
      { key: formatBinding("tui.select.confirm"), label: "Select Provider" },
      { key: formatBinding("tui.select.cancel"), label: "Cancel" },
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
    this.step = "model";
    this.selectedProvider = provider;
    this.searchBar.clear();

    this.title.setText(appTheme.ui.text.bold(`Select Model [${provider.name}]`));

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
      if (model?.reasoning_efforts && model.reasoning_efforts.length > 0) {
        this.switchToReasoningStep(model);
      } else {
        this.options.onSelect({ modelId: item.value });
      }
    };

    this.modelList.onCancel = () => {
      this.handleCancel();
    };

    this.hint.setHints([
      {
        key: `${formatBinding("tui.select.up")}/${formatBinding("tui.select.down")}`,
        label: "Navigate",
      },
      { key: "Type", label: "Search" },
      { key: formatBinding("tui.select.confirm"), label: "Select Model" },
      { key: formatBinding("tui.select.cancel"), label: "Back" },
    ]);
  }

  private switchToReasoningStep(model: ModelItem): void {
    this.step = "reasoning";
    this.selectedModel = model;
    this.searchBar.clear();

    this.title.setText(appTheme.ui.text.bold(`Select Reasoning Effort [${model.modelId}]`));

    const availableEfforts = model.reasoning_efforts || [];

    const isCurrentModel = model.modelId === this.options.currentModelId;
    const currentEffort = isCurrentModel ? this.options.currentReasoningEffort : undefined;

    const items: SelectItem[] = availableEfforts.map((effortKey) => {
      const desc = EFFORT_DESCRIPTIONS[effortKey] || `${effortKey} level`;
      const isActive = currentEffort && effortKey === currentEffort;

      return {
        value: effortKey,
        label: `${effortKey}${isActive ? " (Current)" : ""}`,
        description: desc,
      };
    });

    this.reasoningList = new SelectList(
      items,
      Math.min(8, Math.max(3, items.length)),
      createSelectListTheme(),
    );

    this.reasoningList.onSelect = (item) => {
      this.options.onSelect({
        modelId: model.modelId,
        reasoningEffort: item.value as ReasoningEffort,
      });
    };

    this.reasoningList.onCancel = () => {
      this.handleCancel();
    };

    this.hint.setHints([
      {
        key: `${formatBinding("tui.select.up")}/${formatBinding("tui.select.down")}`,
        label: "Navigate",
      },
      { key: formatBinding("tui.select.confirm"), label: "Confirm" },
      { key: formatBinding("tui.select.cancel"), label: "Back" },
    ]);
  }

  private switchToProviderStep(): void {
    this.step = "provider";
    this.selectedProvider = undefined;
    this.selectedModel = undefined;
    this.searchBar.clear();

    this.title.setText(appTheme.ui.primary.bold("Select AI Provider"));
    this.providerList.setFilter("");

    this.hint.setHints([
      {
        key: `${formatBinding("tui.select.up")}/${formatBinding("tui.select.down")}`,
        label: "Navigate",
      },
      { key: "Type", label: "Search" },
      { key: formatBinding("tui.select.confirm"), label: "Select Provider" },
      { key: formatBinding("tui.select.cancel"), label: "Cancel" },
    ]);
  }

  private handleCancel(): void {
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
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // 1. Render Title
    lines.push(...this.title.render(width));

    // 2. Render Search Bar (only in provider and model steps)
    if (this.step !== "reasoning") {
      lines.push(...this.searchBar.render(width));
    } else {
      lines.push(appTheme.ui.muted("Select reasoning level:"));
    }

    // 3. Render Active Step List
    lines.push("");
    if (this.step === "reasoning" && this.reasoningList) {
      lines.push(...this.reasoningList.render(width));
    } else if (this.step === "model" && this.modelList) {
      lines.push(...this.modelList.render(width));
    } else {
      lines.push(...this.providerList.render(width));
    }

    // 4. Render Hint
    lines.push("");
    lines.push(...this.hint.render(width));

    return lines;
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    const selectBindings = [
      "tui.select.up",
      "tui.select.down",
      "tui.select.pageUp",
      "tui.select.pageDown",
      "tui.select.confirm",
      "tui.select.cancel",
    ] as const;
    if (selectBindings.some((binding) => keys.matches(data, binding))) {
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

    if (this.step !== "reasoning") {
      this.searchBar.handleInput(data);
      this.applySearchFilter();
    }
  }
}
