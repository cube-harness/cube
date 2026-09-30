import { Text, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { formatBinding, matchesBinding } from "../keybindings.js";
import { appTheme } from "../themes/app.theme.js";
import { KeyHint } from "./key-hint.js";
import { SearchBar } from "./search-bar.js";

export type FieldPickerItem = { id: string; label: string; description: string; selected: boolean };

// Title and status-line settings share selection behavior, but supply their own preview.
export class FieldPicker implements Component, Focusable {
  private readonly title: Text;
  private readonly search = new SearchBar();
  private readonly hint = new KeyHint([
    { key: "Space", label: "Toggle [ ]/[x]" },
    { key: "Type", label: "Filter" },
    {
      key: formatBinding("tui.select.up") + "/" + formatBinding("tui.select.down"),
      label: "Navigate",
    },
    { key: formatBinding("tui.select.confirm"), label: "Apply" },
    { key: formatBinding("tui.select.cancel"), label: "Cancel" },
  ]);
  private selectedIds: string[];
  private selectedIndex = 0;
  private errorMessage?: string;

  constructor(
    private readonly options: {
      title: string;
      items: FieldPickerItem[];
      initialSelection: string[];
      preview(ids: string[]): string;
      onSelect(ids: string[]): void;
      onCancel(): void;
    },
  ) {
    this.title = new Text(appTheme.ui.text.bold(options.title), 0, 0);
    this.selectedIds = [...options.initialSelection];
  }

  get focused(): boolean {
    return this.search.focused;
  }
  set focused(value: boolean) {
    this.search.focused = value;
  }
  getSelectedIds(): string[] {
    return [...this.selectedIds];
  }

  private filteredItems(): FieldPickerItem[] {
    const query = this.search.getQuery().toLowerCase().trim();
    return this.options.items.filter((item) =>
      [item.id, item.label, item.description].some((value) => value.toLowerCase().includes(query)),
    );
  }

  render(width: number): string[] {
    const items = this.filteredItems();
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, items.length - 1));
    const lines = [...this.title.render(width), ...this.search.render(width), ""];
    if (!items.length) lines.push(appTheme.ui.muted("(No matching components found)"));
    for (const [index, item] of items.entries()) {
      const active = index === this.selectedIndex;
      const cursor = active ? appTheme.ui.primary("❯") : " ";
      const checkbox = this.selectedIds.includes(item.id)
        ? appTheme.status.success("[x]")
        : appTheme.ui.muted("[ ]");
      const label = active ? appTheme.ui.primary.bold(item.label) : appTheme.ui.text(item.label);
      const description = (active ? appTheme.ui.primary : appTheme.ui.muted)(
        `(${item.description})`,
      );
      lines.push(`${cursor} ${checkbox} ${label} ${description}`);
    }
    if (this.errorMessage) lines.push(appTheme.status.warning(`⚠ ${this.errorMessage}`));

    lines.push(
      "",
      `${appTheme.ui.muted("Preview:")} ${this.options.preview(this.getSelectedIds())}`,
      "",
    );
    return [...lines.map((line) => truncateToWidth(line, width)), ...this.hint.render(width)];
  }

  handleInput(data: string): void {
    if (matchesBinding(data, "tui.select.up") || data === "k") {
      this.errorMessage = undefined;
      const count = this.filteredItems().length;
      if (count) this.selectedIndex = (this.selectedIndex - 1 + count) % count;
      return;
    }
    if (matchesBinding(data, "tui.select.down") || data === "j") {
      this.errorMessage = undefined;
      const count = this.filteredItems().length;
      if (count) this.selectedIndex = (this.selectedIndex + 1) % count;
      return;
    }
    if (data === " ") {
      const item = this.filteredItems()[this.selectedIndex];
      if (item) {
        if (this.selectedIds.includes(item.id)) {
          if (this.selectedIds.length <= 1) {
            this.errorMessage = "At least one option must be selected.";
            return;
          }
          this.selectedIds = this.selectedIds.filter((id) => id !== item.id);
        } else this.selectedIds.push(item.id);
        this.errorMessage = undefined;
      }
      return;
    }
    if (matchesBinding(data, "tui.select.confirm")) {
      if (!this.selectedIds.length) this.errorMessage = "At least one option must be selected.";
      else this.options.onSelect(this.getSelectedIds());
      return;
    }
    this.errorMessage = undefined;
    if (matchesBinding(data, "tui.select.cancel")) {
      if (this.search.getQuery()) {
        this.search.clear();
        this.selectedIndex = 0;
      } else this.options.onCancel();
      return;
    }
    this.search.handleInput(data);
    this.selectedIndex = 0;
  }

  invalidate(): void {
    this.title.invalidate();
    this.search.invalidate();
    this.hint.invalidate();
  }
}
