// cube-tui/src/components/title-picker.ts
import {
  Container,
  Text,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";
import { KeyHint } from "./key-hint.js";
import { SearchBar } from "./search-bar.js";
import { matchesBinding, formatBinding } from "../keybindings.js";

export interface TitlePickerItem {
  id: string;
  label: string;
  description: string;
  selected: boolean;
}

export interface TerminalTitleValues {
  model?: string;
  workspace?: string;
  threadTitle?: string;
  threadId?: string;
  status?: string;
}

export const DEFAULT_TITLE_SEPARATOR = " | ";

export function formatTerminalTitle(
  fields: string[],
  values: TerminalTitleValues,
  separator: string = DEFAULT_TITLE_SEPARATOR,
): string {
  const parts: string[] = [];
  for (const field of fields) {
    if (field === "model" && values.model) parts.push(values.model);
    else if (field === "workspace" && values.workspace) parts.push(values.workspace);
    else if (field === "threadTitle" && values.threadTitle) parts.push(values.threadTitle);
    else if (field === "threadId" && values.threadId) parts.push(values.threadId);
    else if (field === "status" && values.status) parts.push(values.status);
  }
  return parts.length > 0 ? parts.join(separator) : values.model || values.workspace || "Cube";
}

export interface TitlePickerOptions {
  items?: TitlePickerItem[];
  initialSelection?: string[];
  currentValues?: TerminalTitleValues;
  onSelect: (selectedIds: string[]) => void;
  onCancel: () => void;
}

export class TitlePickerComponent extends Container implements Component, Focusable {
  focused = true;
  private readonly title: Text;
  private readonly searchBar: SearchBar;
  private readonly hint: KeyHint;
  private readonly items: TitlePickerItem[];
  private selectedIds: string[];
  private selectedIndex = 0;
  private errorMessage?: string;

  constructor(private readonly options: TitlePickerOptions) {
    super();
    const current = options.currentValues ?? {};
    const initial = options.initialSelection ?? ["model", "workspace", "threadTitle"];

    this.title = new Text(appTheme.ui.text.bold("Configure Terminal Title"), 0, 0);
    this.searchBar = new SearchBar();

    this.items = options.items ?? [
      {
        id: "model",
        label: "Active Model",
        description: current.model || "cube-agent",
        selected: initial.includes("model"),
      },
      {
        id: "workspace",
        label: "Workspace Directory",
        description: current.workspace || process.cwd(),
        selected: initial.includes("workspace"),
      },
      {
        id: "threadTitle",
        label: "Thread Title",
        description: current.threadTitle || "Untitled Thread",
        selected: initial.includes("threadTitle"),
      },
      {
        id: "threadId",
        label: "Thread ID",
        description: current.threadId || "new thread",
        selected: initial.includes("threadId"),
      },
      {
        id: "status",
        label: "Agent Status",
        description: current.status || "Idle",
        selected: initial.includes("status"),
      },
    ];

    this.selectedIds = options.items
      ? options.items.filter((i) => i.selected).map((i) => i.id)
      : [...initial];

    this.hint = new KeyHint([
      { key: "Space", label: "Toggle [ ]/[x]" },
      { key: "Type", label: "Filter" },
      {
        key: `${formatBinding("tui.select.up")}/${formatBinding("tui.select.down")}`,
        label: "Navigate",
      },
      { key: formatBinding("tui.select.confirm"), label: "Apply" },
      { key: formatBinding("tui.select.cancel"), label: "Cancel" },
    ]);

    this.addChild(this.title);
    this.addChild(this.searchBar);
    this.addChild(this.hint);
  }

  private getFilteredItems(): { item: TitlePickerItem; originalIndex: number }[] {
    const query = this.searchBar.getQuery().toLowerCase().trim();
    if (!query) {
      return this.items.map((item, index) => ({ item, originalIndex: index }));
    }
    return this.items
      .map((item, index) => ({ item, originalIndex: index }))
      .filter(
        ({ item }) =>
          item.label.toLowerCase().includes(query) ||
          item.description.toLowerCase().includes(query) ||
          item.id.toLowerCase().includes(query),
      );
  }

  getSelectedIds(): string[] {
    return [...this.selectedIds];
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const availableWidth = Math.max(width, 20);

    lines.push(...this.title.render(availableWidth));
    lines.push(...this.searchBar.render(availableWidth));
    lines.push("");

    const filtered = this.getFilteredItems();
    if (filtered.length === 0) {
      lines.push(appTheme.ui.muted("  (No matching components found)"));
    } else {
      if (this.selectedIndex >= filtered.length) {
        this.selectedIndex = Math.max(0, filtered.length - 1);
      }

      for (let i = 0; i < filtered.length; i++) {
        const { item } = filtered[i];
        const isHovered = i === this.selectedIndex;
        const isSelected = this.selectedIds.includes(item.id);
        const cursor = isHovered ? appTheme.ui.primary("❯") : " ";
        const checkbox = isSelected ? appTheme.status.success("[x]") : appTheme.ui.muted("[ ]");
        const label = isHovered
          ? appTheme.ui.primary.bold(item.label)
          : appTheme.ui.text(item.label);
        const desc = isHovered
          ? appTheme.ui.primary(`(${item.description})`)
          : appTheme.ui.muted(`(${item.description})`);

        const line = `  ${cursor} ${checkbox} ${label} ${desc}`;
        lines.push(truncateToWidth(line, availableWidth));
      }
    }

    if (this.errorMessage) {
      lines.push(appTheme.status.warning(`  ⚠ ${this.errorMessage}`));
    }

    // Live Preview
    const current = this.options.currentValues ?? {};
    const previewText = formatTerminalTitle(this.selectedIds, current);

    lines.push("");
    lines.push(appTheme.ui.muted("  Preview:"));
    lines.push(`  ${appTheme.ui.primary(truncateToWidth(previewText, availableWidth - 4))}`);

    lines.push("");
    lines.push(...this.hint.render(availableWidth));
    return lines;
  }

  handleInput(data: string): void {
    // 1. Navigation Up
    if (matchesBinding(data, "tui.select.up") || data === "k") {
      this.errorMessage = undefined;
      const filtered = this.getFilteredItems();
      if (filtered.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + filtered.length) % filtered.length;
      }
      return;
    }

    // 2. Navigation Down
    if (matchesBinding(data, "tui.select.down") || data === "j") {
      this.errorMessage = undefined;
      const filtered = this.getFilteredItems();
      if (filtered.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % filtered.length;
      }
      return;
    }

    // 3. Space: Toggle [ ] / [x]
    if (data === " ") {
      const filtered = this.getFilteredItems();
      if (filtered.length > 0 && filtered[this.selectedIndex]) {
        const target = filtered[this.selectedIndex].item;
        const isCurrentlySelected = this.selectedIds.includes(target.id);
        if (isCurrentlySelected) {
          if (this.selectedIds.length <= 1) {
            this.errorMessage = "At least one option must be selected.";
            return;
          }
          this.errorMessage = undefined;
          this.selectedIds = this.selectedIds.filter((id) => id !== target.id);
        } else {
          this.errorMessage = undefined;
          this.selectedIds.push(target.id);
        }
      }
      return;
    }

    // 4. Confirm Enter
    if (matchesBinding(data, "tui.select.confirm")) {
      const selected = this.getSelectedIds();
      if (selected.length === 0) {
        this.errorMessage = "At least one option must be selected.";
        return;
      }
      this.options.onSelect(selected);
      return;
    }

    // 5. Cancel Escape
    if (matchesBinding(data, "tui.select.cancel")) {
      this.errorMessage = undefined;
      if (this.searchBar.getQuery()) {
        this.searchBar.clear();
        this.selectedIndex = 0;
        return;
      }
      this.options.onCancel();
      return;
    }

    // 6. Search Bar input
    this.errorMessage = undefined;
    this.searchBar.handleInput(data);
    this.selectedIndex = 0;
  }
}
