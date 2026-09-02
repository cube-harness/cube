import {
  Container,
  Text,
  getKeybindings,
  SelectList,
  truncateToWidth,
  type SelectItem,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";
import { KeyHint } from "./key-hint.js";
import { SearchBar } from "./search-bar.js";
import { formatBinding } from "../keybindings.js";

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

const truncatePlainText = (str: string, maxWidth: number): string => {
  if (str.length <= maxWidth) return str;
  return str.slice(0, Math.max(0, maxWidth - 3)) + "...";
};

export class ThreadPickerOverlay extends Container implements Component, Focusable {
  focused = true;
  private readonly title: Text;
  private readonly searchBar: SearchBar;
  private readonly threadList: SelectList;
  private readonly hint: KeyHint;

  constructor(private readonly options: ThreadPickerOptions) {
    super();

    this.title = new Text(appTheme.ui.text.bold("Select Conversation Thread"), 0, 0);
    this.searchBar = new SearchBar();

    const CURRENT_TAG = " (Current)";
    const items: SelectItem[] = options.threads.map((t) => {
      const currentTag = t.isActive ? CURRENT_TAG : "";
      const rawTitle = t.title || "Untitled Thread";
      const dateStr = t.updatedAt ? formatDateTime(t.updatedAt) : "";
      return {
        value: t.id,
        label: `${rawTitle}${currentTag}`,
        description: `[${t.id}]${dateStr ? `  ${dateStr}` : ""}`,
      };
    });

    this.threadList = new SelectList(
      items,
      Math.min(10, Math.max(3, items.length)),
      createSelectListTheme(),
      {
        minPrimaryColumnWidth: 35,
        maxPrimaryColumnWidth: 48,
        truncatePrimary: ({ item, maxWidth }) => {
          const isCurrent = item.label.endsWith(CURRENT_TAG);
          if (isCurrent) {
            const rawTitle = item.label.slice(0, -CURRENT_TAG.length);
            const availableForTitle = Math.max(10, maxWidth - CURRENT_TAG.length);
            const truncatedTitle = truncatePlainText(rawTitle, availableForTitle);
            return `${truncatedTitle}${CURRENT_TAG}`;
          }
          return truncatePlainText(item.label, maxWidth);
        },
      },
    );

    this.threadList.onSelect = (item) => {
      this.options.onSelect(item.value);
    };

    this.threadList.onCancel = () => {
      if (this.searchBar.getQuery()) {
        this.searchBar.clear();
        this.threadList.setFilter("");
        return;
      }
      this.options.onCancel();
    };

    this.hint = new KeyHint([
      {
        key: `${formatBinding("tui.select.up")}/${formatBinding("tui.select.down")}`,
        label: "Navigate",
      },
      { key: "Type", label: "Search" },
      { key: formatBinding("tui.select.confirm"), label: "Select" },
      { key: formatBinding("tui.select.cancel"), label: "Cancel" },
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
      this.threadList.handleInput(data);
      return;
    }
    this.searchBar.handleInput(data);
    this.threadList.setFilter(this.searchBar.getQuery());
  }
}
