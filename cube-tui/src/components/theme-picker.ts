// cube-tui/src/components/theme-picker.ts
import {
  Container,
  Text,
  SelectList,
  Markdown,
  visibleWidth,
  truncateToWidth,
  type SelectItem,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { getTheme, getAvailableThemes, THEMES, type ColorTheme } from "../themes/color.schema.js";
import { createSelectListTheme, createMarkdownTheme } from "../themes/pi-tui.theme.js";
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

/**
 * Sample markdown fed through the REAL `Markdown` component + REAL
 * `createMarkdownTheme(previewTheme)` for every preview render. This used to
 * be a hand-simulated box (each line built by hand with raw `t.xxx()` calls,
 * copied over from antigravity-cli) that could silently drift from what the
 * app actually renders — a heading, a link, or the new syntax-highlighted
 * code block could look one way here and another way in the real TUI. Piping
 * the same string through the same component + theme factory the rest of
 * the app uses means the preview IS the real render, by construction, not an
 * approximation of it — and it automatically covers every MarkdownTheme
 * field (heading/bold/italic/strikethrough/link/code/codeBlock+highlightCode/
 * quote/hr/list) without anyone having to keep a second hand-written sample
 * in sync by hand.
 */
const MARKDOWN_PREVIEW_SAMPLE = `## greet.ts

Sure — here's the plan: export \`greet(name)\` with input *validation* and a **regression test**.

- Called from \`src/index.ts\`
- Covered by [the test suite](file:///path/to/greet.test.ts)

\`\`\`ts
function greet(name: string) {
  // guard against empty input
  if (!name) throw new Error("name required");
  return \`Hello, \${name}!\`;
}
\`\`\`

> Replaces the old \`sayHi()\` helper — see the diff below.

~~sayHi() removed~~`;

export class ThemePickerOverlay extends Container implements Component, Focusable {
  focused = true;
  private readonly title: Text;
  private readonly selectList: SelectList;
  private readonly hint: KeyHint;
  private hoveredThemeId: string;

  constructor(private readonly options: ThemePickerOptions) {
    super();
    const currentTheme = getTheme();
    const availableThemes =
      options.themes && options.themes.length > 0 ? options.themes : getAvailableThemes();
    const activeId =
      options.currentThemeId ||
      Object.keys(THEMES).find((k) => THEMES[k] === currentTheme) ||
      "default";

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
      { key: `${formatBinding("tui.select.up")}/${formatBinding("tui.select.down")}`, label: "Navigate" },
      { key: formatBinding("tui.select.confirm"), label: "Apply Theme" },
      { key: formatBinding("tui.select.cancel"), label: "Cancel" },
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

    // --- ACTOR strip: who's speaking. Not covered by MarkdownTheme, so
    // still drawn directly from the ColorTheme, but each row now uses ONE
    // consistent convention instead of the old ad-hoc mix: informational
    // rows (user/assistant/tool/task) lead with a neutral `muted` label and
    // let the VALUE carry the color (color = "what/who"); SIGNAL rows
    // (error/warning) lead with the color ON the label itself, because an
    // alert should grab the eye at the icon, before you've even read the
    // message.
    const userLine = `> you: add a greeting function`;
    lines.push(formatLine(t.user(userLine), visibleWidth(userLine)));
    lines.push(formatLine("", 0));

    // --- Real markdown, real component, real (previewed) theme. The reply
    // itself opens with "Sure — here's the plan..." (inside the markdown
    // string below), so there's no separate hand-written assistant intro
    // line here — that used to duplicate the markdown's own opening
    // sentence. Renders
    // heading/bold/italic/strikethrough/list/inline-code/link/quote AND the
    // syntax-highlighted code block in one pass, guaranteed to match
    // production because it IS production's Markdown + theme factory.
    const markdown = new Markdown(MARKDOWN_PREVIEW_SAMPLE, 0, 0, createMarkdownTheme(t));
    for (const mdLine of markdown.render(innerWidth)) {
      lines.push(formatLine(mdLine, visibleWidth(mdLine)));
    }
    lines.push(formatLine("", 0));

    // --- Diff sample: same file/language as the code block above
    // (src/greet.ts, TypeScript) — was Go (`func main()`) before, which had
    // nothing to do with the TS snippet just shown two sections up. Whole
    // line colored success/error, the established convention for +/- diff
    // rows (not a MarkdownTheme concern).
    const diff1 = `  3   // src/greet.ts`;
    lines.push(formatLine(t.muted(diff1), visibleWidth(diff1)));
    const diff2Raw = `  5 - function sayHi() {`;
    lines.push(formatLine(t.error(diff2Raw), visibleWidth(diff2Raw)));
    const diff3Raw = `  5 + function greet(name: string) {`;
    lines.push(formatLine(t.success(diff3Raw), visibleWidth(diff3Raw)));
    lines.push(formatLine("", 0));

    // --- Agent status strip: thought process, tool call, task, signals.
    const thoughtTitle = `▾ Thought Process`;
    lines.push(formatLine(t.secondary(thoughtTitle), visibleWidth(thoughtTitle)));
    const thoughtDesc = `  Need to validate empty input before formatting the greeting.`;
    lines.push(formatLine(t.muted(thoughtDesc), visibleWidth(thoughtDesc)));

    const toolPrefix = `⚙ tool: `;
    const toolVal = `write_file greet.ts`;
    lines.push(
      formatLine(
        `${t.muted(toolPrefix)}${t.tool(toolVal)}`,
        visibleWidth(`${toolPrefix}${toolVal}`),
      ),
    );

    const taskPrefix = `◉ task: `;
    const taskVal = `Implementing greeting`;
    lines.push(
      formatLine(
        `${t.muted(taskPrefix)}${t.primary(taskVal)}`,
        visibleWidth(`${taskPrefix}${taskVal}`),
      ),
    );

    // SIGNAL rows: color leads on the label/icon itself (see convention note
    // above), value stays in `assistant` since the message body is ordinary
    // readable text, not itself the alert.
    const errPrefix = `✗ error: `;
    const errVal = `compilation failed`;
    lines.push(
      formatLine(
        `${t.error(errPrefix)}${t.assistant(errVal)}`,
        visibleWidth(`${errPrefix}${errVal}`),
      ),
    );

    const warnPrefix = `⚠ warning: `;
    const warnVal = `deprecation warning`;
    lines.push(
      formatLine(
        `${t.warning(warnPrefix)}${t.assistant(warnVal)}`,
        visibleWidth(`${warnPrefix}${warnVal}`),
      ),
    );

    const dimLine = `· dim: press Enter to apply this theme`;
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
    this.selectList.handleInput(data);
    const currentSelected = this.selectList.getSelectedItem();
    if (currentSelected) {
      this.hoveredThemeId = currentSelected.value;
    }
  }
}
