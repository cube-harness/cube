import {
  Container,
  SelectList,
  Text,
  matchesKey,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";

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

export class ThreadPickerOverlay extends Container implements Component {
  private readonly selectList: SelectList;
  private readonly title: Text;
  private readonly searchDisplay: Text;
  private readonly hint: Text;
  private searchQuery = "";
  private readonly allItems: SelectItem[];

  constructor(private readonly options: ThreadPickerOptions) {
    super();
    const theme = getTheme();

    this.title = new Text(theme.primary.bold("Select Conversation Thread"));
    this.searchDisplay = new Text(theme.muted("Search: ") + theme.muted("(none)"));

    const maxTitleLength = 60;
    this.allItems = options.threads.map((t) => {
      const rawTitle = t.title || "Untitled Thread";
      const displayTitle =
        rawTitle.length > maxTitleLength
          ? `${rawTitle.slice(0, maxTitleLength - 3)}...`
          : rawTitle;
      const dateStr = t.updatedAt
        ? new Date(t.updatedAt).toLocaleString()
        : "";
      const activeTag = t.isActive ? " (Active)" : "";
      return {
        value: t.id,
        label: `[${dateStr}] ${displayTitle}${activeTag}`,
        description: t.id,
      };
    });

    this.selectList = new SelectList(
      this.allItems,
      Math.min(10, Math.max(3, this.allItems.length)),
      createSelectListTheme(),
    );

    this.selectList.onSelect = (item) => options.onSelect(item.value);
    this.selectList.onCancel = () => options.onCancel();

    this.hint = new Text(
      theme.muted("↑/↓: Navigate • Type: Search • Enter: Select • Esc: Cancel"),
    );

    this.addChild(this.title);
    this.addChild(this.searchDisplay);
    this.addChild(this.selectList);
    this.addChild(this.hint);
  }

  private updateSearchDisplay(): void {
    const theme = getTheme();
    const queryText = this.searchQuery
      ? theme.primary(this.searchQuery)
      : theme.muted("(none)");
    const cursor = theme.muted(" ▏");
    this.searchDisplay.setText(
      theme.muted("Search: ") + queryText + cursor,
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.searchQuery) {
        this.searchQuery = "";
        this.selectList.setFilter("");
        this.updateSearchDisplay();
        return;
      }
      this.options.onCancel();
      return;
    }

    if (matchesKey(data, "backspace")) {
      if (this.searchQuery.length > 0) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.selectList.setFilter(this.searchQuery);
        this.updateSearchDisplay();
      }
      return;
    }

    if (data.length === 1 && data >= " " && data <= "~") {
      this.searchQuery += data;
      this.selectList.setFilter(this.searchQuery);
      this.updateSearchDisplay();
      return;
    }

    this.selectList.handleInput(data);
  }
}
