// cube-tui/src/themes/pi-tui.theme.ts
import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
} from "@earendil-works/pi-tui";
import { getTheme } from "./color.schema.js";

export const createSelectListTheme = (): SelectListTheme => {
  const theme = getTheme();
  return {
    selectedPrefix: theme.primary,
    // Selection state now carries weight (.bold), not just hue — a selected
    // row should out-rank a merely-colored one the same way `bold` markdown
    // out-ranks plain text. Color alone doesn't survive a monochrome/limited
    // terminal profile; the bold ANSI code does.
    selectedText: theme.primary.bold,
    description: theme.muted,
    scrollInfo: theme.muted,
    noMatch: theme.warning,
  };
};

export const createEditorTheme = (): EditorTheme => ({
  borderColor: getTheme().border,
  selectList: createSelectListTheme(),
});

/**
 * Every typographic field below (`bold`, `italic`, `underline`, `strikethrough`)
 * previously carried ONLY a hue with zero ANSI style modifier attached — e.g.
 * `italic: theme.secondary` renders as plain colored text, never actually
 * italic. That drops the semantic signal markdown authors intended (an
 * *italicized* word is not the same claim as a blue word) and makes two
 * distinct markdown features — a hyperlink and a literal <u>underline</u> —
 * indistinguishable from a generically-colored span. Chalk's modifiers
 * (.bold/.italic/.underline/.strikethrough) chain onto .hex() instances, so
 * each field now encodes its semantic in the actual escape sequence, with hue
 * reserved for theme identity — the two concerns no longer collapse into one.
 *
 * `code` now reads codeAccent (a dedicated CONTENT hue) instead of `warning`
 * (a SIGNAL hue) — see color.schema.ts for the measured hue/contrast proof.
 *
 * `listBullet` moved from `primary` to `muted`: a bullet is punctuation, not
 * information. Coloring it identically to headings/links/bold text gave a
 * zero-information glyph the same visual weight as the highest-signal content
 * on the line, which competes for attention it hasn't earned.
 */
export const createMarkdownTheme = (): MarkdownTheme => {
  const theme = getTheme();
  return {
    // Heading needs to outrank inline `bold` (both would otherwise render
    // identically in `primary`) — same hue, extra weight + underline so a
    // heading is unambiguously the top of the hierarchy at a glance.
    heading: theme.primary.bold.underline,
    link: theme.secondary.underline,
    linkUrl: theme.muted,
    code: theme.codeAccent,
    codeBlock: theme.assistant,
    codeBlockBorder: theme.border,
    quote: theme.muted,
    quoteBorder: theme.border,
    hr: theme.border,
    listBullet: theme.muted, // was theme.primary — see note above
    bold: theme.primary.bold,
    italic: theme.secondary.italic,
    strikethrough: theme.muted.strikethrough,
    underline: theme.secondary.underline,
  };
};