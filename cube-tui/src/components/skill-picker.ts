import {
  SelectList,
  Text,
  Key,
  matchesKey,
  getKeybindings,
  fuzzyFilter,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { SkillChoice } from "@cube/runtime";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";
import { appTheme } from "../themes/app.theme.js";
import { KeyHint } from "./key-hint.js";
import { SearchBar } from "./search-bar.js";

export class SkillPicker implements Component, Focusable {
  private readonly searchBar = new SearchBar();
  get focused(): boolean {
    return this.searchBar.focused;
  }
  set focused(value: boolean) {
    this.searchBar.focused = value;
  }
  private list!: SelectList;
  private busy = false;
  private readonly initial: Map<string, boolean>;
  constructor(
    private items: SkillChoice[],
    private readonly options: {
      onApply(changes: Pick<SkillChoice, "path" | "enabled">[]): Promise<void>;
      onCancel(): void;
      onError(error: unknown): void;
      onChange(): void;
    },
  ) {
    this.initial = new Map(items.map((skill) => [skill.path, skill.enabled]));
    this.items = items.map((skill) => ({ ...skill }));
    this.rebuild();
  }

  private rebuild(selected?: string): void {
    const nameWidth = Math.max(0, ...this.items.map((skill) => visibleWidth(skill.name)));
    const visible = fuzzyFilter(
      this.items,
      this.searchBar.getQuery().trim(),
      (skill) => `${skill.name} ${skill.source} ${skill.path}`,
    );
    this.list = new SelectList(
      visible.map((skill) => ({
        value: skill.path,
        label: `${skill.enabled ? appTheme.status.success("[x]") : appTheme.ui.muted("[ ]")} ${skill.name}${" ".repeat(nameWidth - visibleWidth(skill.name))}  ${appTheme.ui.muted(skill.description.replace(/\s+/g, " ").trim())}`,
      })),
      10,
      { ...createSelectListTheme(), noMatch: () => appTheme.ui.muted("No matching skills.") },
      {
        truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, "…"),
      },
    );
    this.list.setSelectedIndex(
      Math.max(
        0,
        visible.findIndex((skill) => skill.path === selected),
      ),
    );
    this.list.onSelect = () => {
      void this.apply();
    };
    this.list.onCancel = this.options.onCancel;
  }

  private toggle(): void {
    const item = this.items.find((skill) => skill.path === this.list.getSelectedItem()?.value);
    if (!item || this.busy) return;
    item.enabled = !item.enabled;
    this.rebuild(item.path);
    this.options.onChange();
  }

  private async apply(): Promise<void> {
    if (this.busy) return;
    const changes = this.items
      .filter((skill) => skill.enabled !== this.initial.get(skill.path))
      .map(({ path, enabled }) => ({ path, enabled }));
    if (!changes.length) {
      this.options.onCancel();
      return;
    }
    this.busy = true;
    this.options.onChange();
    try {
      await this.options.onApply(changes);
      this.options.onCancel();
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.busy = false;
      this.options.onChange();
    }
  }

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, Key.escape)) {
      this.options.onCancel();
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.toggle();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      void this.apply();
      return;
    }
    const keys = getKeybindings();
    if (
      (
        ["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const
      ).some((binding) => keys.matches(data, binding))
    ) {
      this.list.handleInput(data);
    } else {
      this.searchBar.handleInput(data);
      this.rebuild();
    }
    this.options.onChange();
  }

  invalidate(): void {
    this.list.invalidate();
    this.searchBar.invalidate();
  }

  render(width: number): string[] {
    const selected = this.items.find((skill) => skill.path === this.list.getSelectedItem()?.value);
    return [
      ...new Text(appTheme.ui.text.bold(this.busy ? "Skills · Saving…" : "Enabled/Disable Skills"), 0, 0).render(
        width,
      ),
      ...this.searchBar.render(width),
      "",
      ...(this.items.length
        ? this.list.render(width)
        : new Text("No skills found.", 0, 0).render(width)),
      "",
      truncateToWidth(
        `${appTheme.ui.muted("Source: ")}${appTheme.ui.primary(selected?.path ?? "—")}`,
        width,
        "…",
      ),
      "",
      ...new KeyHint([
        { key: "↑/↓", label: "Navigate" },
        { key: "Type", label: "Search" },
        { key: "Space", label: "Toggle" },
        { key: "Enter", label: "Apply" },
        { key: "Esc", label: "Cancel" },
      ]).render(width),
    ];
  }
}
