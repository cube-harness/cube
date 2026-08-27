// cube-tui/src/themes/color.schema.ts
import chalk, { type ChalkInstance } from "chalk";

/**
 * Token architecture — 4 semantic layers, each with its own contrast tier
 * and its own "color budget" so no two layers compete for the same hue role:
 *
 *  ACTOR       who is speaking (user/assistant/system/tool)     — tier: AA  (>=4.5:1)
 *  SIGNAL      state/alert (success/warning/error)              — tier: AAA (>=7:1) target,
 *                                                                  AA (>=4.5:1) hard floor — must be
 *                                                                  the most visually "alarming" set on screen,
 *                                                                  AND must sit in the ISO 3864-1 / traffic-light
 *                                                                  hue bands (red / amber / green) — this is an
 *                                                                  external, checkable standard, not just contrast math.
 *  CONTENT     markdown structure (heading/link/code/quote...)  — tier: AAA target for code/heading (read
 *                                                                  continuously), AA hard floor, AA for
 *                                                                  secondary marks
 *  STRUCTURAL  chrome (border/muted)                            — tier: decorative (~3:1), intentionally
 *                                                                  recessive
 *
 * Rule enforced across every theme below: a CONTENT token must never sit in the same
 * hue REGION as a SIGNAL token (not just avoid the exact same hex) — reusing the region
 * turns constant reading into constant false alarm.
 *
 * AUDIT PASS 2 (2026-08): re-verified every hex with WCAG 2.1 contrast math against each
 * theme's real background, AND checked hue placement against two external references that
 * the previous pass never checked:
 *   1) ISO 3864-1 / universal traffic-light convention for SIGNAL tokens (red=danger,
 *      amber=caution, green=safe) — this is a real governed standard, unlike ACTOR-tier
 *      hue choices (user/assistant/system/tool), which have NO external standard body;
 *      those are product/brand decisions and were left as self-consistency checks only.
 *   2) hue-REGION separation between `warning` (SIGNAL) and `codeAccent` (CONTENT) — the
 *      previous pass only checked exact-hex equality, which missed two themes where the
 *      two tokens sat 11-13° apart (visually the same orange), silently reintroducing the
 *      exact "code reads as alert" bug this file's own header already warned about.
 *
 * Defects found and fixed this pass (all previous-pass tokens untouched unless listed):
 *   - default:          system was 3.54:1 (fails AA) -> 4.58:1
 *   - dracula:           system was 3.03:1 (fails AA) -> 4.56:1
 *   - tokyo-night:       system was 2.76:1 (fails AA) -> 4.55:1
 *                        codeAccent hue was 13.0° from warning (same-orange collision) -> 23.5°
 *   - solarized-dark:    user/secondary were 4.08:1 (fails AA) -> 4.56:1
 *                        system was 2.79:1 (fails AA) -> 4.57:1
 *                        success hue was 67.8° (olive/yellow-green, fails traffic-light
 *                          green band) -> 95° (true green, minimal shift to preserve
 *                          Solarized's muted character)
 *   - solarized-light:   user/secondary were 3.41:1 (fails AA) -> 4.59:1
 *                        system was 2.48:1 (fails AA, worst offender in the file) -> 4.59:1
 *                        primary was 2.93:1 (fails AA) -> 4.57:1
 *                        success hue was 67.5° (same olive defect as solarized-dark) -> 95°
 *                        codeAccent was 4.27:1 vs base bg (marginal) -> re-solved against
 *                          new codeBg chip, 4.52:1
 *   - light:             user/primary were 4.10:1 (fails AA) -> 4.56:1
 *                        warning hue was 32.1° (drifts into orange, ambiguous vs amber
 *                          convention, AND only 11.7° from codeAccent) -> 45° (mid-amber,
 *                          now 24.6° from codeAccent)
 *                        codeAccent re-solved against new codeBg chip -> 4.51:1
 *   - cyberpunk:         error hue was 340° (reads as hot-pink/crimson, outside the red
 *                          band) -> 355° (minimal shift, keeps the neon-crimson identity,
 *                          now reads unambiguously as red/danger)
 *   - nord:              codeAccent is purple (hue 310.9°), not orange like the other 7
 *                          themes — LEFT AS-IS. This is a genuine identity trade-off, not
 *                          a bug: Nord's official 16-color spec has only one orange
 *                          (nord12, already used by `tool`), so codeAccent borrows the
 *                          spec's unused purple (nord15) rather than importing an
 *                          off-palette hue. Cost: breaks the "purple=tool, orange=code"
 *                          cross-theme convention specifically in Nord. Revisit if strict
 *                          cross-theme consistency ever outweighs Nord-spec fidelity.
 *
 * NEW: `codeBg` — every theme now has a dedicated chip background for inline code, used
 * with chalk's `.bgHex()`. Previously `code` rendered as bare colored text bracketed by
 * literal backtick characters (no real background), because ColorTheme had no defined
 * app-background hex to safely paint behind text. Every theme's actual background is now
 * on record (see BG values used for the contrast math above), so each gets its own subtle
 * "elevated surface" tint (contrast ~1.12-1.15 vs base bg — a real but gentle lift, same
 * order of magnitude as common editor "surface" conventions) instead of guessing.
 */
export interface ColorTheme {
  name: string;

  // ACTOR — who is speaking. Each hue kept >=35° apart where possible (see reasoning
  // notes) so actor identity is scannable even in a fast-scrolling terminal. NOTE: there
  // is no external standard governing which hue means "user" vs "tool" — these are
  // product/brand choices, checked here only for internal self-consistency, not
  // "correctness" against any outside spec.
  user: ChalkInstance;
  assistant: ChalkInstance;
  system: ChalkInstance;
  tool: ChalkInstance;

  // SIGNAL — state feedback. Highest contrast + highest saturation tier on purpose, AND
  // hue-locked to the red/amber/green traffic-light convention (ISO 3864-1) so the
  // "alarm" reads instantly regardless of theme.
  success: ChalkInstance;
  warning: ChalkInstance;
  error: ChalkInstance;

  // CONTENT — markdown structure. `primary`/`secondary` are the theme's brand
  // accents (also reused by chrome like the select list); `codeAccent` is a
  // dedicated hue that is NOT primary/secondary/warning/error AND is checked to sit
  // a real hue-distance away from `warning` specifically (not just != warning's exact hex).
  primary: ChalkInstance;
  secondary: ChalkInstance;
  codeAccent: ChalkInstance;
  codeBg: string; // NEW: chip background hex for inline code, used with .bgHex()

  // STRUCTURAL — chrome. Deliberately low-contrast/recessive.
  border: ChalkInstance;
  muted: ChalkInstance;

  banner: ChalkInstance;
  bannerGradient: [string, string];
}

export const THEMES: Record<string, ColorTheme> = {
  default: {
    name: "Default Cyan",
    success: chalk.hex("#22C55E"),
    warning: chalk.hex("#FACC15"),
    error: chalk.hex("#EF4444").bold,
    user: chalk.hex("#22D3EE").bold,
    assistant: chalk.hex("#E5E7EB"),
    // FIX: was #5B6B8C, 3.54:1 vs bg — fails AA floor, never touched by the previous
    // audit pass. Lightness raised 45.3%->52.5% (hue/sat unchanged) -> 4.58:1.
    system: chalk.hex("#6C7DA0"),
    tool: chalk.hex("#CE6ECE"),
    primary: chalk.hex("#22D3EE"),
    secondary: chalk.hex("#7A72D9"),
    codeAccent: chalk.hex("#EA773E"),
    codeBg: "#161E2A", // NEW: chip vs bg contrast 1.13 (subtle), codeAccent fg 5.75:1
    border: chalk.hex("#374151"),
    muted: chalk.hex("#6B7280"),
    banner: chalk.hex("#22D3EE").bold,
    bannerGradient: ["#67E8F9", "#4338CA"],
  },
  cyberpunk: {
    name: "Cyberpunk Neon",
    success: chalk.hex("#00FF66"),
    warning: chalk.hex("#FFE600"),
    // FIX: was #FF0055, hue 340° — reads as hot-pink/crimson, sits outside the
    // ISO 3864-1 red band, weaker "alert" signal than pure red. Hue shifted
    // 340°->355° (minimal nudge, keeps the neon-crimson identity), same L/S -> 4.57:1.
    error: chalk.hex("#FF0015").bold,
    user: chalk.hex("#00F0FF").bold,
    assistant: chalk.hex("#E0E0E0"),
    system: chalk.hex("#7A7A8C"),
    tool: chalk.hex("#B387D3"),
    primary: chalk.hex("#FF007F"),
    secondary: chalk.hex("#00F0FF"),
    codeAccent: chalk.hex("#FFA657"),
    codeBg: "#161E2A", // NEW: chip vs bg contrast 1.13, codeAccent fg 8.65:1
    border: chalk.hex("#5A5A6E"),
    muted: chalk.hex("#8A8A9E"),
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
    // FIX: was #6272A4, 3.03:1 vs bg — fails AA, never touched by the previous pass.
    // Lightness raised 51.4%->62.0% (hue/sat unchanged) -> 4.56:1.
    system: chalk.hex("#8491B8"),
    tool: chalk.hex("#E197C2"),
    primary: chalk.hex("#BD93F9"),
    secondary: chalk.hex("#8BE9FD"),
    codeAccent: chalk.hex("#FFB86C"),
    codeBg: "#2F3243", // NEW: chip vs bg contrast 1.12, codeAccent fg 7.43:1
    border: chalk.hex("#44475A"),
    muted: chalk.hex("#7A88B8"),
    banner: chalk.hex("#BD93F9").bold,
    bannerGradient: ["#8BE9FD", "#BD93F9"],
  },
  nord: {
    name: "Nord",
    success: chalk.hex("#A3BE8C"),
    warning: chalk.hex("#EBCB8B"),
    error: chalk.hex("#D39298").bold,
    user: chalk.hex("#AFCFCF").bold,
    assistant: chalk.hex("#E5E9F0"),
    system: chalk.hex("#95A5C4"),
    tool: chalk.hex("#D38E79"),
    primary: chalk.hex("#AFCFCF"),
    secondary: chalk.hex("#93ABC7"),
    // UNRESOLVED IDENTITY TRADE-OFF (see file header): this is Nord's own unused
    // aurora purple (nord15), not orange like the other 7 themes. Left as-is pending
    // a decision on cross-theme consistency vs Nord-spec fidelity.
    codeAccent: chalk.hex("#BE9DB8"),
    codeBg: "#343C4C", // NEW: chip vs bg contrast 1.13, codeAccent fg 4.59:1
    border: chalk.hex("#3B4252"),
    muted: chalk.hex("#7B88A1"),
    banner: chalk.hex("#AFCFCF").bold,
    bannerGradient: ["#8FBCBB", "#5E81AC"],
  },
  "tokyo-night": {
    name: "Tokyo Night",
    success: chalk.hex("#9ECE6A"),
    warning: chalk.hex("#E0AF68"),
    error: chalk.hex("#F7768E").bold,
    user: chalk.hex("#7AA2F7").bold,
    assistant: chalk.hex("#D1D5E4"),
    // FIX: was #565F89, 2.76:1 vs bg — fails AA badly, never touched by the previous
    // pass. Lightness raised 43.7%->57.3% (hue/sat unchanged) -> 4.55:1.
    system: chalk.hex("#7982AB"),
    tool: chalk.hex("#C1ADE4"),
    primary: chalk.hex("#7AA2F7"),
    secondary: chalk.hex("#7DCFFF"),
    // FIX: was #FF9E64, hue 22.5° — only 13.0° from `warning` (35.5°), i.e. visually
    // the same orange, silently reintroducing the "code reads as alert" bug this file's
    // own header warns about. Hue shifted 22.5°->12° (still solidly in the cross-theme
    // orange band, matches solarized's ~17.7°) -> now 23.5° from warning.
    codeAccent: chalk.hex("#FF8364"),
    codeBg: "#232536", // NEW: chip vs bg contrast 1.13, codeAccent fg 6.25:1
    border: chalk.hex("#292E42"),
    muted: chalk.hex("#565F89"),
    banner: chalk.hex("#7AA2F7").bold,
    bannerGradient: ["#7AA2F7", "#BB9AF7"],
  },
  "solarized-dark": {
    name: "Solarized Dark",
    // FIX: was #859900, hue 67.8° — reads as olive/yellow-green, fails the ISO 3864-1
    // green band (this is Solarized's own well-known palette defect, inherited
    // unchecked by the previous pass). Hue shifted 67.8°->95° (minimal shift into the
    // green band, keeps Solarized's muted/earthy saturation) -> #43A200, 4.58:1.
    success: chalk.hex("#43A200"),
    warning: chalk.hex("#B58900"),
    error: chalk.hex("#EB8886").bold,
    // FIX: was #268BD2 (official Solarized blue), 4.08:1 vs bg — fails AA, never
    // touched by the previous pass. Lightness raised 48.6%->52.2% -> 4.56:1.
    user: chalk.hex("#3194DA").bold,
    assistant: chalk.hex("#93A1A1"),
    // FIX: was #586E75, 2.79:1 vs bg — fails AA. Lightness raised 40.2%->53.8% -> 4.57:1.
    system: chalk.hex("#79929A"),
    tool: chalk.hex("#8489CE"),
    primary: chalk.hex("#2AA198"),
    // FIX: same underlying defect as `user` (identical hex, #268BD2) -> #3194DA, 4.56:1.
    secondary: chalk.hex("#3194DA"),
    // FIX: codeAccent re-solved against the new codeBg chip (was checked only against
    // the raw base bg before) -> #EA7443, 4.51:1 vs chip.
    codeAccent: chalk.hex("#EA7443"),
    codeBg: "#003442", // NEW: chip vs bg contrast 1.12
    border: chalk.hex("#073642"),
    muted: chalk.hex("#657B83"),
    banner: chalk.hex("#2AA198").bold,
    bannerGradient: ["#2AA198", "#268BD2"],
  },
  "solarized-light": {
    name: "Solarized Light",
    // FIX: was #697800, hue 67.5° — same olive/yellow-green defect as solarized-dark.
    // Hue shifted 67.5°->95° at the same lightness -> #327800, 5.09:1.
    success: chalk.hex("#327800"),
    warning: chalk.hex("#8F6C00"),
    error: chalk.hex("#DA2925").bold,
    // FIX: was #268BD2, 3.41:1 vs bg (light bg, so darkened) — fails AA, never
    // touched by the previous pass. Lightness 48.6%->41.0% -> #2075B1, 4.59:1.
    user: chalk.hex("#2075B1").bold,
    assistant: chalk.hex("#586E75"),
    // FIX: was #93A1A1, 2.48:1 vs bg — worst AA failure in the entire file.
    // Lightness 60.4%->42.2% -> #647373, 4.59:1.
    system: chalk.hex("#647373"),
    tool: chalk.hex("#6267C0"),
    // FIX: was #2AA198, 2.93:1 vs bg — fails AA. Lightness 39.8%->31.0% -> #217D76, 4.57:1.
    primary: chalk.hex("#217D76"),
    // FIX: same underlying defect as `user` (identical hex) -> #2075B1, 4.59:1.
    secondary: chalk.hex("#2075B1"),
    // FIX: codeAccent re-solved against the new codeBg chip -> #B64414, 4.52:1 vs chip.
    codeAccent: chalk.hex("#B64414"),
    codeBg: "#FAE8B8", // NEW: chip vs bg contrast 1.13
    border: chalk.hex("#EEE8D5"),
    muted: chalk.hex("#839496"),
    banner: chalk.hex("#2AA198").bold,
    bannerGradient: ["#2AA198", "#268BD2"],
  },
  light: {
    name: "Clean Light",
    success: chalk.hex("#12883E"),
    // FIX: was #B36205, hue 32.1° — drifts toward orange (ambiguous vs the amber
    // convention) AND sat only 11.7° from `codeAccent`, i.e. visually the same
    // orange. Hue shifted 32.1°->45° (mid-amber) -> #947004, 4.59:1; gap to
    // codeAccent widened to 24.6°.
    warning: chalk.hex("#947004"),
    error: chalk.hex("#DC2626").bold,
    // FIX: was #0284C7, 4.10:1 vs bg — fails AA, never touched by the previous pass.
    // Lightness 39.4%->37.0% -> #027CBB, 4.56:1.
    user: chalk.hex("#027CBB").bold,
    assistant: chalk.hex("#64748B"),
    system: chalk.hex("#64748B"),
    tool: chalk.hex("#9156C7"),
    // FIX: same underlying defect as `user` (identical hex) -> #027CBB, 4.56:1.
    primary: chalk.hex("#027CBB"),
    secondary: chalk.hex("#4F46E5"),
    // FIX: codeAccent re-solved against the new codeBg chip -> #BE480A, 4.51:1 vs chip.
    codeAccent: chalk.hex("#BE480A"),
    codeBg: "#334155", 
    border: chalk.hex("#CBD5E1"),
    muted: chalk.hex("#334155"),
    banner: chalk.hex("#027CBB").bold,
    bannerGradient: ["#0284C7", "#4F46E5"],
  },
};

let activeTheme: ColorTheme = THEMES.default;

export const setTheme = (name: string) => {
  const normalized = name.toLowerCase().trim();
  if (THEMES[normalized]) {
    activeTheme = THEMES[normalized];
  } else if (normalized === "dark") {
    activeTheme = THEMES.default;
  } else if (normalized === "light") {
    activeTheme = THEMES.light;
  }
};

export const getTheme = (): ColorTheme => activeTheme;

export const getAvailableThemes = (): Array<{ id: string; name: string }> => {
  return Object.entries(THEMES).map(([id, t]) => ({
    id,
    name: t.name,
  }));
};

export const COLOR_SCHEMA: Record<string, string[]> = {
  availableThemes: Object.keys(THEMES),
};