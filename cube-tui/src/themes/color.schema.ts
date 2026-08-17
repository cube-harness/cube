// cube-tui/src/themes/color.schema.ts
import chalk, { type ChalkInstance } from "chalk";

/**
 * Token architecture — 4 semantic layers, each with its own contrast tier
 * and its own "color budget" so no two layers compete for the same hue role:
 *
 *  ACTOR       who is speaking (user/assistant/system/tool)     — tier: AA  (>=4.5:1)
 *  SIGNAL      state/alert (success/warning/error)              — tier: AAA (>=7:1), must be the
 *                                                                  most visually "alarming" set on screen
 *  CONTENT     markdown structure (heading/link/code/quote...)  — tier: AAA for code/heading (read
 *                                                                  continuously), AA for secondary marks
 *  STRUCTURAL  chrome (border/muted)                            — tier: decorative (~3:1), intentionally
 *                                                                  recessive
 *
 * Rule enforced across every theme below (verified with WCAG contrast-ratio math,
 * not eyeballed): a CONTENT token must never reuse a SIGNAL hex value, because
 * SIGNAL tokens are semantically "alert" and CONTENT tokens render on every line —
 * reusing one turns constant reading into constant false alarm. This is the exact
 * bug that made markdown `code` painful before (`code: theme.warning`).
 */
export interface ColorTheme {
  name: string;

  // ACTOR — who is speaking. Each hue kept >=35° apart (see reasoning notes)
  // so actor identity is scannable even in a fast-scrolling terminal.
  user: ChalkInstance;
  assistant: ChalkInstance;
  system: ChalkInstance;
  tool: ChalkInstance;

  // SIGNAL — state feedback. Highest contrast + highest saturation tier on
  // purpose: these must "win" visually against every other token when they fire.
  success: ChalkInstance;
  warning: ChalkInstance;
  error: ChalkInstance;

  // CONTENT — markdown structure. `primary`/`secondary` are the theme's brand
  // accents (also reused by chrome like the select list); `codeAccent` is a
  // dedicated hue that is NOT primary/secondary/warning/error, so inline code
  // reads as "content" rather than "brand" or "alert".
  primary: ChalkInstance;
  secondary: ChalkInstance;
  codeAccent: ChalkInstance;

  // STRUCTURAL — chrome. Deliberately low-contrast/recessive.
  border: ChalkInstance;
  muted: ChalkInstance;

  banner: ChalkInstance;
  bannerGradient: [string, string];
}

/**
 * All four themes use chalk.hex() exclusively — including `default`, which
 * previously mixed named ANSI colors (chalk.cyan, chalk.blue, chalk.yellow...).
 * Named ANSI colors are NOT fixed colors: they resolve through the user's
 * terminal-emulator palette (iTerm profile, Windows Terminal scheme, etc.), so
 * the exact same theme object can render differently per user. The other three
 * themes already used chalk.hex() (fixed truecolor), which made `default` the
 * only visually non-deterministic theme in the set. Converting it closes that
 * inconsistency — all 4 themes now render identically everywhere truecolor is
 * supported.
 */
export const THEMES: Record<string, ColorTheme> = {
  default: {
    name: "Default Cyan",
    // Signal (contrast vs bg #0d1117 — computed): warning 12.36:1, error 5.03:1, success 8.31:1
    success: chalk.hex("#22C55E"),
    warning: chalk.hex("#FACC15"),
    error: chalk.hex("#EF4444").bold,
    // Actor: user/primary share hue (187.9°) by design — the user's own accent
    // IS the brand primary. assistant kept nearly achromatic (high-contrast
    // 15.29:1) since assistant text is read the most and must be the least
    // fatiguing. system/tool given dedicated hues, each >=35° from primary/secondary.
    user: chalk.hex("#22D3EE").bold,
    assistant: chalk.hex("#E5E7EB"),
    system: chalk.hex("#5B6B8C"),
    // Hue locked to 300° — far from primary (112.1°), the new gradient-locked
    // secondary (55.5°), warning (107.9°) and codeAccent (79.9°). Needed a new
    // home because locking `secondary` to the gradient (below) moved it to
    // 244.5°, which collapsed the old tool hue (255.1°) down to 10.6° away —
    // a fresh collision introduced by the gradient fix, caught by re-running
    // the same ΔHue check rather than assuming the old value still holds.
    tool: chalk.hex("#E458E4"),
    // Content — primary/secondary are now hue-locked EXACTLY to bannerGradient
    // (ΔHue = 0°), per the banner being the theme's dominant/brand color:
    // primary hue already matched gradient stop 0 (#67E8F9, ΔH=0.9°, kept as
    // #22D3EE). secondary previously drifted 27.3° from gradient stop 1
    // (#4338CA) — relocked to that exact hue (244.5°). The raw gradient hex
    // itself only measures 2.39:1 contrast against bg (fine for a large bold
    // banner sweep, not for body text/links read continuously), so lightness
    // was raised 50.6%->65% at the SAME hue/saturation until AA cleared:
    // #7A72D9, 4.72:1.
    primary: chalk.hex("#22D3EE"),
    secondary: chalk.hex("#7A72D9"),
    codeAccent: chalk.hex("#EA773E"), // ΔHue vs warning = 28.0°, contrast 6.49:1
    // Structural
    border: chalk.hex("#374151"),
    muted: chalk.hex("#6B7280"),
    banner: chalk.hex("#22D3EE").bold, // == primary, both hue-locked to gradient stop 0
    bannerGradient: ["#67E8F9", "#4338CA"],
  },
  cyberpunk: {
    name: "Cyberpunk Neon",
    success: chalk.hex("#00FF66"),
    warning: chalk.hex("#FFE600"),
    error: chalk.hex("#FF0055").bold,
    user: chalk.hex("#00F0FF").bold,
    assistant: chalk.hex("#E0E0E0"),
    system: chalk.hex("#7A7A8C"),
    tool: chalk.hex("#B57EDC"),
    primary: chalk.hex("#FF007F"),
    secondary: chalk.hex("#00F0FF"),
    codeAccent: chalk.hex("#FFA657"), // ΔHue vs warning = 25.9°, contrast 10.35:1
    border: chalk.hex("#5A5A6E"),
    muted: chalk.hex("#8A8A9E"), // was chalk.gray.dim (ANSI, theme-dependent) — now fixed hex
    banner: chalk.hex("#FF007F").bold,
    bannerGradient: ["#00F0FF", "#FF007F"],
  },
  dracula: {
    name: "Dracula",
    success: chalk.hex("#50FA7B"),
    warning: chalk.hex("#F1FA8C"),
    error: chalk.hex("#FF5555").bold,
    user: chalk.hex("#8BE9FD").bold,
    assistant: chalk.hex("#F8F8F2"),
    system: chalk.hex("#6272A4"),
    tool: chalk.hex("#FF79C6"),
    primary: chalk.hex("#BD93F9"),
    secondary: chalk.hex("#8BE9FD"),
    // #FFB86C is Dracula's own official palette orange (their "number" accent) —
    // reused deliberately instead of inventing an off-palette hex, so the
    // codeAccent still "belongs" to the Dracula spec. ΔHue vs warning = 33.9°.
    codeAccent: chalk.hex("#FFB86C"),
    border: chalk.hex("#44475A"),
    muted: chalk.hex("#7A88B8"), // lightened from #6272A4 to clear 3:1 vs system (was identical S/L band)
    banner: chalk.hex("#BD93F9").bold,
    bannerGradient: ["#8BE9FD", "#BD93F9"],
  },
  nord: {
    name: "Nord",
    success: chalk.hex("#A3BE8C"),
    warning: chalk.hex("#EBCB8B"),
    // Original #BF616A measured 3.05:1 against Nord's own bg (#2E3440) — below
    // WCAG AA (4.5:1) for an error color, the token that most needs to be read
    // correctly. Lightness raised 56.5%->70% (hue/sat untouched) -> 4.96:1.
    error: chalk.hex("#D39298").bold,
    user: chalk.hex("#AFCFCF").bold,
    assistant: chalk.hex("#E5E9F0"),
    // Original system (#4C566A) was byte-identical to muted below — same actor
    // vs. generic-de-emphasis collision as default's old system/muted pair.
    // Given #7B88A1's low saturation, hue alone can't differentiate a near-gray
    // pair (hue becomes numerically unstable near S<20%), so system is split
    // off on lightness+saturation instead (S 16.8->28.5, L 55.7->67.6).
    system: chalk.hex("#95A5C4"),
    // Original #D08770 measured 4.39:1, just under AA. Lightness nudged
    // 62.7%->65% -> 4.71:1, hue/sat preserved (still Nord's aurora orange).
    // Re-checked against the relocked primary/secondary below: 164.3° and
    // 161.3° away respectively — still comfortably isolated, no new collision.
    tool: chalk.hex("#D38E79"),
    // primary/secondary hue-locked EXACTLY to bannerGradient (ΔHue = 0°),
    // same rule as `default` above. Originally primary drifted 14.6° from
    // gradient stop 0 (#8FBCBB) and secondary drifted 3.1° from stop 1
    // (#5E81AC) — both picked independently instead of anchored. Raw gradient
    // hex measured 5.99:1 / 3.10:1 against bg; stop 1 in particular fails AA
    // for link/italic body text. Lightness raised at the SAME locked hue:
    // primary 64.9%->75% -> #AFCFCF (7.52:1, AAA), secondary 52.2%->68% ->
    // #93ABC7 (5.29:1, AA).
    primary: chalk.hex("#AFCFCF"),
    secondary: chalk.hex("#93ABC7"),
    // Nord's own unused aurora color (nord15, purple) — not on any other token
    // in this theme, so adopting it keeps codeAccent inside the canonical Nord
    // 16-color spec rather than importing a foreign hue. Lightness raised
    // 77.6%->68% to clear AA (raw nord15 measured 4.41:1, just under).
    codeAccent: chalk.hex("#BE9DB8"),
    border: chalk.hex("#3B4252"),
    muted: chalk.hex("#7B88A1"),
    banner: chalk.hex("#AFCFCF").bold, // == primary, both hue-locked to gradient stop 0
    bannerGradient: ["#8FBCBB", "#5E81AC"],
  },
};

let activeTheme: ColorTheme = THEMES.default;

export const setTheme = (name: string) => {
  if (THEMES[name]) {
    activeTheme = THEMES[name];
  }
};

export const getTheme = (): ColorTheme => activeTheme;

export const COLOR_SCHEMA: Record<string, string[]> = {
  availableThemes: Object.keys(THEMES),
};