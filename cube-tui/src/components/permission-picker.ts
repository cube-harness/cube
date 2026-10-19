import {
  Key,
  SelectList,
  Text,
  fuzzyFilter,
  getKeybindings,
  matchesKey,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { PermissionPolicy, PermissionState } from "@cube/runtime";
import { appTheme } from "../themes/app.theme.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";
import { KeyHint } from "./key-hint.js";
import { SearchBar } from "./search-bar.js";

export class PermissionPicker implements Component, Focusable {
  private readonly state: PermissionState;
  private readonly rows: string[];
  private readonly searchBar = new SearchBar();
  private list!: SelectList;
  private busy = false;

  get focused(): boolean {
    return this.searchBar.focused;
  }
  set focused(value: boolean) {
    this.searchBar.focused = value;
  }

  constructor(state: PermissionState, private readonly options: {
    onApply(state: PermissionState): Promise<void>;
    onCancel(): void;
    onError(error: unknown): void;
    onChange(): void;
  }) {
    this.state = structuredClone(state);
    this.rows = ["workspace_only", ...Object.keys(state.tools)];
    this.rebuild();
  }

  private rebuild(selected = "workspace_only"): void {
    const nameWidth = Math.max(...this.rows.map((name) => name.length));
    const visible = fuzzyFilter(this.rows, this.searchBar.getQuery().trim(), (name) => name);
    this.list = new SelectList(visible.map((name) => {
      const scope = name === "workspace_only";
      const choices = scope ? ["Enable", "Disable"] : ["Ask", "Allow", "Deny"];
      const current = scope ? (this.state.workspaceOnly ? "enable" : "disable") : this.state.tools[name];
      return { value: name, label: `${name.padEnd(nameWidth)}  ${choices.map((choice) =>
        choice.toLowerCase() === current ? appTheme.status.success(choice) : appTheme.ui.muted(choice),
      ).join(appTheme.ui.muted(" | "))}` };
    }), 12, {
      ...createSelectListTheme(),
      noMatch: () => appTheme.ui.muted("No matching permissions."),
    });
    this.list.setSelectedIndex(Math.max(0, visible.indexOf(selected)));
    this.list.onSelect = () => { void this.apply(); };
    this.list.onCancel = this.options.onCancel;
  }

  private async apply(): Promise<void> {
    this.busy = true;
    this.options.onChange();
    try {
      await this.options.onApply(structuredClone(this.state));
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
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel")) {
      this.options.onCancel();
      return;
    }
    if (keys.matches(data, "tui.select.confirm")) {
      void this.apply();
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const name = this.list.getSelectedItem()?.value;
      if (!name) return;
      if (name === "workspace_only") this.state.workspaceOnly = !this.state.workspaceOnly;
      else {
        const policies: PermissionPolicy[] = ["ask", "allow", "deny"];
        const direction = matchesKey(data, Key.right) ? 1 : -1;
        this.state.tools[name] = policies[(policies.indexOf(this.state.tools[name]!) + direction + 3) % 3]!;
      }
      this.rebuild(name);
    } else if (
      (["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const)
        .some((binding) => keys.matches(data, binding))
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
    return [
      ...new Text(appTheme.ui.text.bold(this.busy ? "Permissions · Saving…" : "Workspace Permissions"), 0, 0).render(width),
      ...this.searchBar.render(width),
      "",
      ...this.list.render(width),
      "",
      ...new Text(appTheme.ui.muted("workspace_only checks file paths and command cwd, not command contents."), 0, 0).render(width),
      "",
      ...new KeyHint([
        { key: "↑/↓", label: "Navigate" },
        { key: "←/→", label: "Choose" },
        { key: "Type", label: "Search" },
        { key: "Enter", label: "Apply" },
        { key: "Esc", label: "Cancel" },
      ]).render(width),
    ];
  }
}
