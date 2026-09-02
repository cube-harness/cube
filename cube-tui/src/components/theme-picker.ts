// cube-tui/src/components/theme-picker.ts
import {
  Container,
  Text,
  SelectList,
  visibleWidth,
  truncateToWidth,
  type SelectItem,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import hljs from "highlight.js/lib/core";
import { appTheme } from "../themes/app.theme.js";
import {
  getSyntaxTheme,
  getAvailableSyntaxThemes,
  SYNTAX_THEMES,
  type SyntaxTheme,
} from "../themes/syntax.theme.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";
import { highlightToAnsi } from "../themes/code-highlight.js";
import { KeyHint } from "./key-hint.js";
import { formatBinding } from "../keybindings.js";

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

interface PreviewLine {
  gutter: string;
  code: string;
  type: "ctx" | "add" | "del";
}

const UNIFIED_PREVIEW_LINES: PreviewLine[] = [
  { gutter: "01  ", type: "ctx", code: "// @controller: Authentication Service" },
  { gutter: "02  ", type: "ctx", code: "@Injectable()" },
  { gutter: "03  ", type: "ctx", code: "export class AuthService {" },
  { gutter: "04  ", type: "ctx", code: "  constructor(private readonly db: Database) {}" },
  { gutter: "05  ", type: "ctx", code: "  async login(user: User, token: string): Promise<Session> {" },
  { gutter: "06  ", type: "ctx", code: "    const isMatched: boolean = /^[a-z0-9_]+$/i.test(token);" },
  { gutter: "07 -", type: "del", code: "    const expireAt = Date.now() + 1800 * 1000;" },
  { gutter: "07 +", type: "add", code: "    const expireAt = Date.now() + 3600 * 1000;" },
  { gutter: "08  ", type: "ctx", code: "    if (!isMatched) throw new Error(\"Invalid token\");" },
  { gutter: "09  ", type: "ctx", code: "    return { token, expireAt, active: true };" },
  { gutter: "10  ", type: "ctx", code: "  }" },
  { gutter: "11  ", type: "ctx", code: "}" },
];

export class ThemePickerOverlay extends Container implements Component, Focusable {
  focused = true;
  private readonly title: Text;
  private readonly selectList: SelectList;
  private readonly hint: KeyHint;
  private hoveredThemeId: string;

  constructor(private readonly options: ThemePickerOptions) {
    super();
    const currentSyntax = getSyntaxTheme();
    const availableThemes =
      options.themes && options.themes.length > 0
        ? options.themes
        : getAvailableSyntaxThemes();
    const activeId = options.currentThemeId || currentSyntax.id || "default";

    this.hoveredThemeId = activeId;
    this.title = new Text(appTheme.ui.text.bold("Syntax Highlighting Theme"), 0, 0);

    const items: SelectItem[] = availableThemes.map((t) => {
      const isCurrent = t.id === activeId;
      return {
        value: t.id,
        label: t.name,
        description: isCurrent ? "(current)" : undefined,
      };
    });

    this.selectList = new SelectList(
      items,
      Math.min(12, Math.max(4, items.length)),
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
      {
        key: `${formatBinding("tui.select.up")}/${formatBinding("tui.select.down")}`,
        label: "Navigate",
      },
      { key: formatBinding("tui.select.confirm"), label: "Apply Theme" },
      { key: formatBinding("tui.select.cancel"), label: "Cancel" },
    ]);

    this.addChild(this.title);
    this.addChild(this.selectList);
    this.addChild(this.hint);
  }

  private renderPreview(st: SyntaxTheme): string[] {
    const lines: string[] = [];
    lines.push(appTheme.ui.muted("Preview:"));
    lines.push("");

    const fullCode = UNIFIED_PREVIEW_LINES.map((c) => c.code).join("\n");
    const fullHtml = hljs.highlight(fullCode, { language: "typescript", ignoreIllegals: true }).value;
    const highlightedRows = fullHtml.split("\n").map((h) => highlightToAnsi(h, st));

    UNIFIED_PREVIEW_LINES.forEach((item, idx) => {
      const gutter = appTheme.ui.muted(item.gutter + " ");
      const syntaxCode = highlightedRows[idx] || item.code;

      if (item.type === "del") {
        lines.push(`${gutter}${st.tokens.diffRemovedBg(syntaxCode)}`);
      } else if (item.type === "add") {
        lines.push(`${gutter}${st.tokens.diffAddedBg(syntaxCode)}`);
      } else {
        lines.push(`${gutter}${syntaxCode}`);
      }
    });

    return lines;
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Title
    lines.push(...this.title.render(width));
    lines.push("");

    // Calculate Column Widths
    const previewSyntaxTheme = SYNTAX_THEMES[this.hoveredThemeId] || getSyntaxTheme();
    const leftWidth = 30;
    const gap = 3;

    const leftLines = this.selectList.render(leftWidth);
    const rightLines = this.renderPreview(previewSyntaxTheme);

    // Merge two columns side by side
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
    this.selectList.handleInput(data);
    const currentSelected = this.selectList.getSelectedItem();
    if (currentSelected) {
      this.hoveredThemeId = currentSelected.value;
    }
  }
}
