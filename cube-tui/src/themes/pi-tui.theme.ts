// cube-tui/src/themes/pi-tui.theme.ts
import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
} from "@earendil-works/pi-tui";
import { getTheme, type ColorTheme } from "./color.schema.js";
import { createHighlightCode } from "./code-highlight.js";

/**
 * Every factory below now takes an OPTIONAL explicit `theme` (default:
 * `getTheme()`, the globally active one). Every existing call site
 * (`createSelectListTheme()`, `createMarkdownTheme()`, ...) keeps working
 * unchanged. The parameter exists so the theme-picker's live preview can
 * render a *hovered, not-yet-applied* theme by passing it explicitly,
 * instead of only ever being able to render whatever theme is currently
 * active globally — that gap is exactly why the old preview box couldn't
 * show a real, accurate render and had to hand-simulate lines instead.
 */
export const createSelectListTheme = (theme?: ColorTheme): SelectListTheme => ({
  selectedPrefix: (s) => (theme ?? getTheme()).primary(s.replace(/^→ /, "❯ ")),
  // Selection state now carries weight (.bold), not just hue — a selected
  // row should out-rank a merely-colored one the same way `bold` markdown
  // out-ranks plain text. Color alone doesn't survive a monochrome/limited
  // terminal profile; the bold ANSI code does.
  selectedText: (s) => (theme ?? getTheme()).primary.bold(s.replace(/^→ /, "❯ ")),
  description: (s) => (theme ?? getTheme()).muted(s),
  scrollInfo: (s) => (theme ?? getTheme()).muted(s),
  noMatch: (s) => (theme ?? getTheme()).warning(s),
});

export const createEditorTheme = (theme?: ColorTheme): EditorTheme => ({
  borderColor: (s) => (theme ?? getTheme()).border(s),
  selectList: createSelectListTheme(theme),
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
 *
 * FIX — link/underline collision: `link` and `underline` previously both
 * resolved to `secondary.underline(s)`, i.e. identical hue AND identical
 * modifier. That directly violates this file's own stated principle above
 * ("hue reserved for theme identity" so markdown features stay visually
 * distinct): a plain <u>underlined</u> word and an actionable hyperlink
 * rendered as the exact same glyph, so a user could not tell "this is
 * emphasis" from "this is clickable" without hovering/clicking to find out.
 * `link` keeps `secondary.underline` — colored-plus-underlined is the
 * universal, decades-old cross-platform convention for "this is a link"
 * (web browsers, terminal hyperlink escape sequences, every markdown
 * renderer), so it should keep the strongest, most conventional affordance.
 * `underline` (the rare literal-underline markdown feature, independent of
 * links) now uses `assistant` — the body-text hue — plus the underline
 * modifier only, so it reads as "plain text, underlined" rather than
 * borrowing the link's hue and implying false interactivity.
 *
 * FIX — inline code now has a real background chip: `theme.codeBg` (new field
 * on ColorTheme, see color.schema.ts) is a hex string, not a ChalkInstance,
 * because it feeds `.bgHex()` rather than being called as a function. Every
 * theme's real background is now documented and accounted for (see
 * color.schema.ts header), so each theme carries its own dedicated, contrast-
 * verified chip color instead of guessing at an unknown terminal backdrop.
 * The literal backtick delimiters are dropped — the filled background is
 * itself the boundary, same convention as GitHub/VS Code's inline-code pill —
 * and a single space of padding on each side keeps the fg text from touching
 * the chip edge.
 */
export const createMarkdownTheme = (theme?: ColorTheme): MarkdownTheme => ({
  // Heading needs to outrank inline `bold` (both would otherwise render
  // identically in `primary`) — same hue, extra weight + underline so a
  // heading is unambiguously the top of the hierarchy at a glance.
  heading: (s) => (theme ?? getTheme()).primary.bold.underline(s),
  link: (s) => (theme ?? getTheme()).secondary.underline(s),
  linkUrl: (s) => (theme ?? getTheme()).muted(s),
  code: (s) => (theme ?? getTheme()).codeAccent.bgHex((theme ?? getTheme()).codeBg)(` ${s} `),
  codeBlock: (s) => (theme ?? getTheme()).assistant(s),
  codeBlockBorder: (s) => (theme ?? getTheme()).border(s),
  quote: (s) => (theme ?? getTheme()).muted(s),
  quoteBorder: (s) => (theme ?? getTheme()).border(s),
  hr: (s) => (theme ?? getTheme()).border(s),
  listBullet: (s) => (theme ?? getTheme()).muted(s), // was theme.primary — see note above
  bold: (s) => (theme ?? getTheme()).primary.bold(s),
  italic: (s) => (theme ?? getTheme()).secondary.italic(s),
  strikethrough: (s) => (theme ?? getTheme()).muted.strikethrough(s),
  underline: (s) => (theme ?? getTheme()).assistant.underline(s), // was secondary.underline — collided with `link`, see note above
  // Was absent before — code blocks rendered as one flat `codeBlock` color
  // with zero syntax distinction. See code-highlight.ts for the token→hue
  // map (highlight.js-based, scoped to the languages Cube actually touches).
  highlightCode: createHighlightCode(theme ?? getTheme()),
});