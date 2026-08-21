// cube-tui/src/components/theme-picker.ts
import {
  Container,
  Text,
  Key,
  matchesKey,
  SelectList,
  visibleWidth,
  truncateToWidth,
  type SelectItem,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { getTheme, getAvailableThemes, THEMES, type ColorTheme } from "../themes/color.schema.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";
import { KeyHint } from "./key-hint.js";

export interface ThemePickerItem {
  id: string;
  name: string;
}

export interface ThemePickerOptions {
  themes?: ThemePickerItem[];
  currentThemeId?: string;
  onSelect: (themeId: string) => void;
  onCancel: () => void;
}

export class ThemePickerOverlay extends Container implements Component, Focusable {
  focused = true;
  private readonly title: Text;
  private readonly selectList: SelectList;
  private readonly hint: KeyHint;
  private hoveredThemeId: string;

  constructor(private readonly options: ThemePickerOptions) {
    super();
    const currentTheme = getTheme();
    const availableThemes = options.themes && options.themes.length > 0 ? options.themes : getAvailableThemes();
    const activeId = options.currentThemeId || Object.keys(THEMES).find((k) => THEMES[k] === currentTheme) || "default";

    this.hoveredThemeId = activeId;
    this.title = new Text(currentTheme.primary.bold("Color Scheme"), 0, 0);

    const items: SelectItem[] = availableThemes.map((t) => {
      const isCurrent = t.id === activeId;
      return {
        value: t.id,
        label: `${t.name}${isCurrent ? " (current)" : ""}`,
      };
    });

    this.selectList = new SelectList(
      items,
      Math.min(10, Math.max(4, items.length)),
      createSelectListTheme(),
    );

    // Initial selected index to match current theme
    const currentIndex = availableThemes.findIndex((t) => t.id === activeId);
    if (currentIndex >= 0) {
      this.selectList.setSelectedIndex(currentIndex);
    }

    this.selectList.onSelectionChange = (item) => {
      this.hoveredThemeId = item.value;
    };

    this.selectList.onSelect = (item) => {
      this.options.onSelect(item.value);
    };

    this.selectList.onCancel = () => {
      this.options.onCancel();
    };

    this.hint = new KeyHint([
      { key: "↑/↓", label: "Navigate" },
      { key: "Enter", label: "Apply Theme" },
      { key: "Esc", label: "Cancel" },
    ]);

    this.addChild(this.title);
    this.addChild(this.selectList);
    this.addChild(this.hint);
  }

  private renderPreviewBox(t: ColorTheme, boxWidth: number): string[] {
    const lines: string[] = [];
    const innerWidth = Math.max(20, boxWidth - 4);

    const formatLine = (content: string, visibleLen: number): string => {
      const pad = Math.max(0, innerWidth - visibleLen);
      return `${t.border("│")} ${content}${" ".repeat(pad)} ${t.border("│")}`;
    };

    const topBorder = `${t.border("╭")}${t.border("─".repeat(innerWidth + 2))}${t.border("╮")}`;
    const bottomBorder = `${t.border("╰")}${t.border("─".repeat(innerWidth + 2))}${t.border("╯")}`;

    lines.push(topBorder);

    // 1. User Message
    const userLine = `> you: add a greeting function`;
    lines.push(formatLine(t.user(userLine), visibleWidth(userLine)));

    // 2. Empty spacer
    lines.push(formatLine("", 0));

    // 3. Assistant intro
    const asstLine = `  Here's the change:`;
    lines.push(formatLine(t.assistant(asstLine), visibleWidth(asstLine)));

    // 4. Empty spacer
    lines.push(formatLine("", 0));

    // 5. Code diff sample
    const diff1 = `  3   import "fmt"`;
    lines.push(formatLine(t.muted(diff1), visibleWidth(diff1)));

    const diff2 = `  4`;
    lines.push(formatLine(t.muted(diff2), visibleWidth(diff2)));

    const diff3Raw = `  5 - func main() {`;
    lines.push(formatLine(t.error(diff3Raw), visibleWidth(diff3Raw)));

    const diff4Raw = `  5 + func greet(name string) {`;
    lines.push(formatLine(t.success(diff4Raw), visibleWidth(diff4Raw)));

    const diff5Raw = `  6 +     fmt.Printf("Hello, %s!\\n", name)`;
    lines.push(formatLine(t.success(diff5Raw), visibleWidth(diff5Raw)));

    const diff6Raw = `  7   }`;
    lines.push(formatLine(t.muted(diff6Raw), visibleWidth(diff6Raw)));

    // 6. Empty spacer
    lines.push(formatLine("", 0));

    // 7. Thought Process
    const thoughtTitle = `   ▾ Thought Process`;
    lines.push(formatLine(t.secondary(thoughtTitle), visibleWidth(thoughtTitle)));

    const thoughtDesc = `     I need to add a greeting function. I'll use fmt.Printf.`;
    lines.push(formatLine(t.muted(thoughtDesc), visibleWidth(thoughtDesc)));

    // 8. Tool, Task, Signal tokens
    const toolPrefix = `   ⚙ tool: `;
    const toolVal = `write_file main.go`;
    lines.push(formatLine(`${t.muted(toolPrefix)}${t.tool(toolVal)}`, visibleWidth(`${toolPrefix}${toolVal}`)));

    const taskPrefix = `   ◉ task: `;
    const taskVal = `Implementing greeting`;
    lines.push(formatLine(`${t.muted(taskPrefix)}${t.primary(taskVal)}`, visibleWidth(`${taskPrefix}${taskVal}`)));

    const errPrefix = `   ✗ error: `;
    const errVal = `compilation failed`;
    lines.push(formatLine(`${t.error(errPrefix)}${t.assistant(errVal)}`, visibleWidth(`${errPrefix}${errVal}`)));

    const warnPrefix = `   ⚠ warning: `;
    const warnVal = `deprecation warning`;
    lines.push(formatLine(`${t.warning(warnPrefix)}${t.assistant(warnVal)}`, visibleWidth(`${warnPrefix}${warnVal}`)));

    // 9. Link line (Underline strictly on URL only, never trailing or on prefix)
    const linkPrefix = `   → link: `;
    const linkUrl = `file:///path/to/main.go`;
    lines.push(formatLine(`${t.muted(linkPrefix)}${t.primary.underline(linkUrl)}`, visibleWidth(`${linkPrefix}${linkUrl}`)));

    // 10. Accent and Dim
    const accentPrefix = `   ★ accent: `;
    const accentVal = `highlighted text`;
    lines.push(formatLine(`${t.muted(accentPrefix)}${t.codeAccent(accentVal)}`, visibleWidth(`${accentPrefix}${accentVal}`)));

    const dimLine = `   · dim: press Enter to continue`;
    lines.push(formatLine(t.muted(dimLine), visibleWidth(dimLine)));

    lines.push(bottomBorder);

    return lines;
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Title
    lines.push(...this.title.render(width));
    lines.push("");

    // Calculate Column Widths (Compact left column next to preview box)
    const previewTheme = THEMES[this.hoveredThemeId] || getTheme();
    const leftWidth = 28;
    const gap = 3;
    const rightWidth = Math.min(65, Math.max(30, width - leftWidth - gap - 2));

    const leftLines = this.selectList.render(leftWidth);
    const rightLines = this.renderPreviewBox(previewTheme, rightWidth);

    // Merge two columns side by side closely
    const maxRowCount = Math.max(leftLines.length, rightLines.length);
    for (let i = 0; i < maxRowCount; i++) {
      const leftPart = leftLines[i] || "";
      const rightPart = rightLines[i] || "";

      const leftVis = visibleWidth(leftPart);
      const padLeft = Math.max(0, leftWidth - leftVis);
      const row = `${leftPart}${" ".repeat(padLeft)}${" ".repeat(gap)}${rightPart}`;
      lines.push(truncateToWidth(row, width));
    }

    // Hint
    lines.push("");
    lines.push(...this.hint.render(width));

    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "\x1b" || data === "escape") {
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
      this.selectList.handleInput(keyData);
      const currentSelected = this.selectList.getSelectedItem();
      if (currentSelected) {
        this.hoveredThemeId = currentSelected.value;
      }
    }
  }
}
