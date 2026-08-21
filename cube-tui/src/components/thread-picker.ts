import {
  Container,
  Text,
  Key,
  matchesKey,
  SelectList,
  type SelectItem,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";
import { KeyHint } from "./key-hint.js";
import { SearchBar } from "./search-bar.js";

export interface ThreadPickerViewItem {
  id: string;
  title: string;
  updatedAt: string;
  isActive: boolean;
}

export interface ThreadPickerOptions {
  threads: ThreadPickerViewItem[];
  onSelect: (threadId: string) => void;
  onCancel: () => void;
}

const formatDateTime = (dateStr: string): string => {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  } catch {
    return dateStr;
  }
};

export class ThreadPickerOverlay extends Container implements Component, Focusable {
  focused = true;
  private readonly title: Text;
  private readonly searchBar: SearchBar;
  private readonly threadList: SelectList;
  private readonly hint: KeyHint;

  constructor(private readonly options: ThreadPickerOptions) {
    super();
    const theme = getTheme();

    this.title = new Text(theme.primary.bold("Select Conversation Thread"), 0, 0);
    this.searchBar = new SearchBar();

    const items: SelectItem[] = options.threads.map((t) => {
      const currentTag = t.isActive ? " (Current)" : "";
      const rawTitle = t.title || "Untitled Thread";
      return {
        value: t.id,
        label: `${rawTitle} [${t.id}]${currentTag}`,
        description: t.updatedAt ? formatDateTime(t.updatedAt) : undefined,
      };
    });

    this.threadList = new SelectList(
      items,
      Math.min(10, Math.max(3, items.length)),
      createSelectListTheme(),
    );

    this.threadList.onSelect = (item) => {
      this.options.onSelect(item.value);
    };

    this.threadList.onCancel = () => {
      this.options.onCancel();
    };

    this.hint = new KeyHint([
      { key: "↑/↓", label: "Navigate" },
      { key: "Type", label: "Search" },
      { key: "Enter", label: "Select" },
      { key: "Esc", label: "Cancel" },
    ]);

    this.addChild(this.title);
    this.addChild(this.searchBar);
    this.addChild(this.threadList);
    this.addChild(this.hint);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(...this.title.render(width));
    lines.push(...this.searchBar.render(width));
    lines.push("");
    lines.push(...this.threadList.render(width));
    lines.push("");
    lines.push(...this.hint.render(width));
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "\x1b" || data === "escape") {
      if (this.searchBar.getQuery()) {
        this.searchBar.clear();
        this.threadList.setFilter("");
        return;
      }
      this.options.onCancel();
      return;
    }

    if (
      matchesKey(data, Key.up) ||
      matchesKey(data, Key.down) ||
      matchesKey(data, Key.pageUp) ||
      matchesKey(data, Key.pageDown) ||
      matchesKey(data, Key.home) ||
      matchesKey(data, Key.end) ||
      matchesKey(data, Key.enter) ||
      data === "\x1b[A" ||
      data === "\x1b[B" ||
      data === "\r" ||
      data === "\n" ||
      data === "up" ||
      data === "down" ||
      data === "enter"
    ) {
      const keyData = data === "down" ? "\x1b[B" : data === "up" ? "\x1b[A" : data === "enter" ? "\r" : data;
      this.threadList.handleInput(keyData);
      return;
    }

    if (matchesKey(data, Key.backspace) || data === "\x7f" || data === "\b" || data === "backspace") {
      if (this.searchBar.getQuery().length > 0) {
        this.searchBar.backspace();
        this.threadList.setFilter(this.searchBar.getQuery());
      }
      return;
    }

    if (data.length === 1 && data >= " " && data <= "~") {
      this.searchBar.appendChar(data);
      this.threadList.setFilter(this.searchBar.getQuery());
    }
  }
}
