import {
  Container,
  Text,
  Key,
  fuzzyFilter,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";
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
  private readonly hint: KeyHint;
  private currentPage = 0;
  private selectedIndex = 0;
  private readonly pageSize = 5;

  constructor(private readonly options: ThreadPickerOptions) {
    super();
    const theme = getTheme();

    this.title = new Text(theme.primary.bold("Select Conversation Thread"), 0, 0);
    this.searchBar = new SearchBar();
    this.hint = new KeyHint([
      { key: "↑/↓", label: "Navigate" },
      { key: "←/→", label: "Page" },
      { key: "Type", label: "Search" },
      { key: "Enter", label: "Select" },
      { key: "Esc", label: "Cancel" },
    ]);

    this.addChild(this.title);
    this.addChild(this.searchBar);
    this.addChild(this.hint);
  }

  private getFilteredThreads(): ThreadPickerViewItem[] {
    const query = this.searchBar.getQuery().trim();
    if (!query) {
      return this.options.threads;
    }
    return fuzzyFilter(this.options.threads, query, (t) => `${t.title || ""} ${t.id}`);
  }

  render(width: number): string[] {
    const theme = getTheme();
    const lines: string[] = [];

    // 1. Render Title
    lines.push(...this.title.render(width));

    // 2. Render Search Bar
    lines.push(...this.searchBar.render(width));
    lines.push("");

    // 3. Filter and Paginate
    const filtered = this.getFilteredThreads();
    const totalPages = Math.max(1, Math.ceil(filtered.length / this.pageSize));
    this.currentPage = Math.max(0, Math.min(this.currentPage, totalPages - 1));

    const startIndex = this.currentPage * this.pageSize;
    const pageItems = filtered.slice(startIndex, startIndex + this.pageSize);

    if (pageItems.length === 0) {
      lines.push(theme.warning("  No matching threads"));
    } else {
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, pageItems.length - 1));

      for (let i = 0; i < pageItems.length; i++) {
        const item = pageItems[i]!;
        const isSelected = i === this.selectedIndex;
        const prefix = isSelected ? "→ " : "  ";
        const currentTag = item.isActive ? " (Current)" : "";
        const dateStr = item.updatedAt ? formatDateTime(item.updatedAt) : "";

        const prefixWidth = visibleWidth(prefix);
        const dateWidth = visibleWidth(dateStr);
        const idTag = `[${item.id}]${currentTag}`;
        const idTagWidth = visibleWidth(idTag);

        const availableForTitle = Math.max(
          10,
          width - prefixWidth - idTagWidth - dateWidth - 4,
        );

        const rawTitle = item.title || "Untitled Thread";
        let displayTitle = rawTitle;
        if (visibleWidth(rawTitle) > availableForTitle) {
          displayTitle = truncateToWidth(rawTitle, availableForTitle);
        }

        const leftContent = `${displayTitle} ${idTag}`;
        const leftWithPrefix = `${prefix}${leftContent}`;
        const leftWidth = visibleWidth(leftWithPrefix);
        const gap = Math.max(2, width - leftWidth - dateWidth);
        const gapStr = " ".repeat(gap);

        if (isSelected) {
          lines.push(
            theme.primary.bold(`${prefix}${leftContent}${gapStr}${dateStr}`),
          );
        } else {
          lines.push(
            `${theme.assistant(leftWithPrefix)}${gapStr}${theme.muted(dateStr)}`,
          );
        }
      }

      // 4. Pagination status
      lines.push("");
      const totalCount = filtered.length;
      lines.push(
        theme.muted(
          `  Page ${this.currentPage + 1}/${totalPages} • Total: ${totalCount} thread${totalCount > 1 ? "s" : ""}`,
        ),
      );
    }

    lines.push("");

    // 5. Render Hint
    lines.push(...this.hint.render(width));

    return lines;
  }

  handleInput(data: string): void {
    const filtered = this.getFilteredThreads();
    const totalPages = Math.max(1, Math.ceil(filtered.length / this.pageSize));
    const startIndex = this.currentPage * this.pageSize;
    const pageItems = filtered.slice(startIndex, startIndex + this.pageSize);

    // Escape
    if (matchesKey(data, Key.escape) || data === "\x1b" || data === "escape") {
      if (this.searchBar.getQuery()) {
        this.searchBar.clear();
        this.currentPage = 0;
        this.selectedIndex = 0;
        return;
      }
      this.options.onCancel();
      return;
    }

    // Up Arrow
    if (matchesKey(data, Key.up) || data === "\x1b[A" || data === "up") {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
      }
      return;
    }

    // Down Arrow
    if (matchesKey(data, Key.down) || data === "\x1b[B" || data === "down") {
      if (this.selectedIndex < pageItems.length - 1) {
        this.selectedIndex++;
      }
      return;
    }

    // Left Arrow (Previous Page)
    if (matchesKey(data, Key.left) || data === "\x1b[D" || data === "left") {
      if (this.currentPage > 0) {
        this.currentPage--;
        this.selectedIndex = 0;
      }
      return;
    }

    // Right Arrow (Next Page)
    if (matchesKey(data, Key.right) || data === "\x1b[C" || data === "right") {
      if (this.currentPage < totalPages - 1) {
        this.currentPage++;
        this.selectedIndex = 0;
      }
      return;
    }

    // Enter
    if (matchesKey(data, Key.enter) || data === "\r" || data === "\n" || data === "enter") {
      const selectedItem = pageItems[this.selectedIndex];
      if (selectedItem) {
        this.options.onSelect(selectedItem.id);
      }
      return;
    }

    // Backspace
    if (matchesKey(data, Key.backspace) || data === "\x7f" || data === "\b" || data === "backspace") {
      if (this.searchBar.getQuery().length > 0) {
        this.searchBar.backspace();
        this.currentPage = 0;
        this.selectedIndex = 0;
      }
      return;
    }

    // Printable search characters
    if (data.length === 1 && data >= " " && data <= "~") {
      this.searchBar.appendChar(data);
      this.currentPage = 0;
      this.selectedIndex = 0;
    }
  }
}
