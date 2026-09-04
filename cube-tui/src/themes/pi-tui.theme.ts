// cube-tui/src/themes/pi-tui.theme.ts
import chalk from "chalk";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import { type AppTheme, appTheme } from "./app.theme.js";
import { type SyntaxTheme, getSyntaxTheme } from "./syntax.theme.js";
import { createHighlightCode } from "./code-highlight.js";

/**
 * Creates SelectListTheme for SelectList component in pi-tui.
 * Uses appTheme.ui for borders and selected items with the '❯ ' cursor prefix.
 */
export const createSelectListTheme = (customAppTheme?: AppTheme): SelectListTheme => {
  const theme = customAppTheme ?? appTheme;
  return {
    selectedPrefix: (s) => theme.ui.primary.bold(s.replace(/^→ /, "❯ ")),
    selectedText: (s) => theme.ui.primary.bold(s.replace(/^→ /, "❯ ")),
    description: (s) => theme.ui.muted(s),
    scrollInfo: (s) => theme.ui.muted(s),
    noMatch: (s) => theme.status.warning(s),
  };
};

/**
 * Creates EditorTheme for PromptEditor in pi-tui.
 */
export const createEditorTheme = (customAppTheme?: AppTheme): EditorTheme => {
  const theme = customAppTheme ?? appTheme;
  return {
    borderColor: (s) => theme.ui.border(s),
    selectList: createSelectListTheme(theme),
  };
};

/**
 * Creates MarkdownTheme for MessageList in pi-tui.
 * Maps typography and structural elements to appTheme, and syntax highlighting to SyntaxTheme.
 *
 * NOTE for pi-tui:
 * `bold`, `italic`, `underline` must be pure ANSI modifiers without hardcoded foreground colors,
 * so that parent colors (heading `#22D3EE`, link `#60A5FA`, quote `#CBD5E1`, body `#E5E7EB`)
 * are preserved and never overridden by an inner white color code.
 */
const stripForegroundColors = (str: string): string => {
  return str
    .replace(/\u001b\[38;[25];[^m]+m/g, "")
    .replace(/\u001b\[3[0-79]m/g, "")
    .replace(/\u001b\[9[0-7]m/g, "");
};

export const createMarkdownTheme = (
  options?: { appTheme?: AppTheme; syntaxTheme?: SyntaxTheme } | AppTheme,
): MarkdownTheme => {
  const resolvedAppTheme =
    options && "ui" in options
      ? options
      : ((options as { appTheme?: AppTheme })?.appTheme ?? appTheme);
  const resolvedSyntaxTheme =
    options && "tokens" in options
      ? (options as unknown as SyntaxTheme)
      : ((options as { syntaxTheme?: SyntaxTheme })?.syntaxTheme ?? getSyntaxTheme());

  return {
    heading: (s) => resolvedAppTheme.markdown.heading(stripForegroundColors(s)),
    link: (s) => resolvedAppTheme.markdown.link(stripForegroundColors(s)),
    linkUrl: (s) => resolvedAppTheme.markdown.linkUrl(s),
    code: (s) =>
      resolvedAppTheme.markdown.codeInlineText.bgHex(resolvedAppTheme.surface.codeInline)(` ${s} `),
    codeBlock: (s) => resolvedAppTheme.role.assistant(s),
    codeBlockBorder: () => "",
    quote: (s) => resolvedAppTheme.markdown.quote(stripForegroundColors(s)),
    quoteBorder: (s) => resolvedAppTheme.markdown.quoteBorder(s),
    hr: (s) => resolvedAppTheme.ui.border(s),
    listBullet: (s) => resolvedAppTheme.markdown.listBullet(s),
    bold: (s) => resolvedAppTheme.markdown.bold(stripForegroundColors(s)),
    italic: (s) => chalk.italic(s),
    strikethrough: (s) => resolvedAppTheme.markdown.strikethrough(s),
    underline: (s) => chalk.underline(s),
    highlightCode: createHighlightCode(resolvedSyntaxTheme),
  };
};
