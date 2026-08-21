import {
  Container,
  Text,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";

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

export class ThreadPickerOverlay extends Container implements Component {
  private readonly title: Text;
  private readonly searchDisplay: Text;
  private readonly hint: Text;
  private searchQuery = "";
  private currentPage = 0;
  private selectedIndex = 0;
  private readonly pageSize = 5;

  constructor(private readonly options: ThreadPickerOptions) {
    super();
    const theme = getTheme();

    this.title = new Text(theme.primary.bold("Select Conversation Thread"), 0, 0);
    this.searchDisplay = new Text(
      theme.muted("Search: ") +
        theme.muted("Type to filter...") +
        theme.primary("█"),
      0,
      0,
    );

    this.hint = new Text(
      theme.muted("↑/↓: Navigate • ←/→: Page • Type: Search • Enter: Select • Esc: Cancel"),
      0,
      0,
    );

    this.addChild(this.title);
    this.addChild(this.searchDisplay);
    this.addChild(this.hint);
  }

  private getFilteredThreads(): ThreadPickerViewItem[] {
    if (!this.searchQuery.trim()) {
      return this.options.threads;
    }
    const q = this.searchQuery.toLowerCase();
    return this.options.threads.filter((t) => {
      const titleMatch = (t.title || "").toLowerCase().includes(q);
      const idMatch = t.id.toLowerCase().includes(q);
      return titleMatch || idMatch;
    });
  }

  private updateSearchDisplay(): void {
    const theme = getTheme();
    const cursor = theme.primary("█");
    const queryText = this.searchQuery
      ? theme.primary.bold(this.searchQuery)
      : theme.muted("Type to filter...");
    this.searchDisplay.setText(
      theme.muted("Search: ") + queryText + cursor,
    );
  }

  render(width: number): string[] {
    const theme = getTheme();
    const lines: string[] = [];

    // 1. Render Title
    lines.push(...this.title.render(width));

    // 2. Render Search Bar (immediately under Title)
    lines.push(...this.searchDisplay.render(width));
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
      if (this.searchQuery) {
        this.searchQuery = "";
        this.currentPage = 0;
        this.selectedIndex = 0;
        this.updateSearchDisplay();
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
      if (this.searchQuery.length > 0) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.currentPage = 0;
        this.selectedIndex = 0;
        this.updateSearchDisplay();
      }
      return;
    }

    // Printable search characters
    if (data.length === 1 && data >= " " && data <= "~") {
      this.searchQuery += data;
      this.currentPage = 0;
      this.selectedIndex = 0;
      this.updateSearchDisplay();
    }
  }
}
