---
name: pi-tui
description: Build or modify terminal UI (TUI) applications using the @earendil-works/pi-tui TypeScript library — a differential-rendering framework for flicker-free CLI apps (chat interfaces, coding agent UIs, interactive prompts). Use this whenever the user is working on a CLI/terminal interface with pi-tui, mentions components like Editor, SelectList, Markdown, Container, VStack/HStack, ScrollView, TuiMainScreen/TuiAltScreen, or is building something like a cube-tui package. Also use when the user hits rendering bugs (flicker, wrong cursor position, lines exceeding width, IME issues) in a pi-tui-based app, or asks how to add a new component, overlay, or keybinding to a terminal UI built on this library.
compatibility: Requires a TypeScript/Node.js project (Node >=22.19.0) with @earendil-works/pi-tui installed.
metadata:
  pi-tui-version: "0.84.2"
  reference-source: earendil-works/pi packages/tui README (main branch)
---

# pi-tui

`@earendil-works/pi-tui` (formerly `@mariozechner/pi-tui`, now deprecated — always use the `@earendil-works` scope) is a minimal terminal UI framework built around differential rendering: components return arrays of lines, and the renderer only repaints what changed. It's the TUI layer used by the `pi` coding agent CLI, and is a good fit for chat-style or dashboard-style terminal apps.

`references/api-reference.md` was distilled against npm version **0.84.2** (published from `earendil-works/pi`, `packages/tui`). It moves fast — if something in a project's `package.json` looks newer/older than 0.84.x, or an import fails, don't trust the reference blindly: check the installed version (`npm ls @earendil-works/pi-tui`) and diff against `node_modules/@earendil-works/pi-tui/README.md` or the GitHub README before assuming a signature is stale.

Read `references/api-reference.md` for the full component API, theme interfaces, key-detection helpers, and utility functions — it's the complete README reference and worth checking before guessing at a prop name or option shape. This file covers the concepts and decisions that aren't obvious from the API alone.

## Mental model

Everything is a `Component`:

```typescript
interface Component {
  render(width: number): string[];      // required — return lines, none wider than `width`
  handleInput?(data: string): void;      // called when focused and input arrives
  invalidate?(): void;                   // clear cached render state
}
```

The `TUI` interface owns the component tree, focus, overlays, and the render loop. You never render manually — you `tui.addChild()` components and call `tui.requestRender()` when state changes; the renderer diffs and repaints only the changed lines.

**The one rule that causes the most bugs**: a line returned from `render(width)` must never exceed `width` visible columns, or the TUI throws. Always run text through `truncateToWidth()` or `wrapTextWithAnsi()` before returning it — never assume plain `.length` is safe once ANSI styling is involved (`visibleWidth()` strips ANSI codes before measuring).

## Choosing a renderer

- **`TuiMainScreen`** — renders into the normal terminal buffer, preserves scrollback. This is the right default for chat/log-style apps where old output should stay scrollable in the user's terminal history.
- **`TuiAltScreen`** — renders into the alternate screen buffer as a fixed-height viewport with app-owned scrolling (mouse wheel, keyboard, search with Ctrl+Shift+F). Use this when you need a dashboard-like fixed layout, or when you want `VStack`/`HStack`/`ScrollView` to carve the terminal into independently-scrolling regions. `setLayoutRoot()` is only meaningful here — calling it on `TuiMainScreen` does nothing because the terminal itself owns scrollback there.

Don't reach for `TuiAltScreen` just because it sounds more "app-like" — if the user wants their normal terminal scrollback to keep working (most CLI chat tools), `TuiMainScreen` is correct and simpler.

## Building custom components

Start from the built-ins (`Text`, `Editor`, `Markdown`, `SelectList`, `Container`, `Box`, `VStack`/`HStack`, `ScrollView`, `Loader`, `Image` — full list and constructor signatures in the reference) before writing a custom one. When you do need a custom component:

1. Implement `render(width)`, wrap output with `truncateToWidth()`.
2. If it's stateful and expensive to render, cache by width (pattern in reference under "Caching") and clear the cache in `invalidate()`.
3. If it needs keyboard input, implement `handleInput(data)` and dispatch with `matchesKey(data, Key.xxx)` rather than parsing raw escape sequences yourself — `Key` covers modifiers and the Kitty keyboard protocol.
4. If it shows a text cursor (an input-like component), implement `Focusable` (`focused: boolean`, emit `CURSOR_MARKER` before the fake cursor). If it's a *container* that embeds an `Input`/`Editor`, it must also implement `Focusable` and propagate `focused` down to the child — otherwise IME candidate windows (Chinese/Japanese/Korean input) position themselves wrong. This is easy to miss and hard to notice unless you test with an IME.

## Images in TuiAltScreen

If a user reports an `Image` component leaving stale pixels or not clearing while scrolling in `TuiAltScreen`, it's very likely they're on iTerm2, not a bug: iTerm2's inline-image protocol has no delete/crop-on-scroll operation, so `TuiAltScreen` deliberately falls back to a text placeholder there, while full Kitty-protocol terminals (Kitty, Ghostty) and `TuiMainScreen` render it properly. See "Alt-screen image compatibility" in the reference before debugging further.

## Less obvious exports — check before reinventing

The package exports more than the components and the handful of utilities above. Before writing a fuzzy matcher, a keybinding system, a clickable-link renderer, or math rendering from scratch, check if one of these already does it — all are top-level exports from `@earendil-works/pi-tui`, no submodule import needed.

- **`fuzzyMatch(query, text)` / `fuzzyFilter(items, query, getText)`** — subsequence fuzzy matching with scoring (lower score = better), `fuzzyFilter` also sorts and supports whitespace/slash-separated multi-token queries (all tokens must match). Use this for slash-command autocomplete, session/thread pickers, model pickers — anything with a `setFilter`-style search box. Don't hand-roll substring or Levenshtein matching.
- **`KeybindingsManager`, `getKeybindings()`, `setKeybindings()`, `TUI_KEYBINDINGS`** — a full user-remappable keybinding registry (`tui.editor.cursorUp`, `tui.select.confirm`, `tui.altScreen.search`, etc., each with default `KeyId`(s) and a description) already covers cursor movement, editing, selection, and alt-screen navigation. If a coding agent CLI wants "let the user customize keybindings" (Cube likely does, given `pi`'s own CLI has this), extend this registry via declaration merging rather than building a parallel config system. Built-in components already read from it; `matchesKey(data, Key.xxx)` is for one-off custom components that don't need to be user-remappable.
- **`renderLatex(source, options?)`** — renders basic LaTeX math to Unicode text for terminal display (`options.display` stacks fractions/limits vertically). Returns `undefined` on unsupported/malformed syntax — always handle that case (fall back to raw source). Useful if the agent's output includes math and it should look better than raw `$...$`.
- **`hyperlink(text, url)`** — wraps `text` in an OSC 8 escape sequence so terminals that support it render a clickable link showing `text` but opening `url`. Use this instead of printing raw URLs or building the escape sequence by hand.
- **`getOsc8LinkAtColumn(line, column)`** — given a rendered line and a column (e.g. from a mouse click), returns the OSC 8 URL at that position, if any. Pairs with `hyperlink()` for building your own clickable areas outside `TuiAltScreen`'s built-in link-click handling.
- **`sliceByColumn(line, startCol, length, strict?)` / `stripTerminalSequences(str)`** — lower-level text utilities alongside the more commonly used `truncateToWidth`/`wrapTextWithAnsi`/`visibleWidth`. Reach for `sliceByColumn` when extracting a sub-range of a styled line (not just truncating from the start); `stripTerminalSequences` when you need plain text for comparison/search/copy, not display.
- **Low-level Kitty/iTerm2 image API** (`encodeKitty`, `encodeITerm2`, `detectCapabilities`, `getCapabilities`, `renderImage`, `imageFallback`, `getImageDimensions`, and per-format dimension parsers) — the built-in `Image` component already wraps all of this. Only reach for these directly when building a custom image-rendering component that `Image` can't express (e.g. non-standard layout, animation frames); otherwise use `Image`.
- **`Marked`** (re-exported from the `marked` package) — the underlying markdown parser behind the `Markdown` component, exposed in case a project needs to parse markdown into tokens without rendering it as a TUI component.

## Styling across lines

The renderer appends a full SGR + OSC 8 reset at the end of every line, so styles never carry across line boundaries. If a styled multi-line string gets wrapped, reapply styling per line, or just use `wrapTextWithAnsi()` which already handles this.

## Overlays

For dialogs/menus on top of existing content, use the overlay system rather than manually composing components — it handles anchor positioning (`'center'`, `'top-left'`, etc.), absolute/percentage placement, margin clamping to terminal bounds, and a per-frame `visible` callback. See the reference for the exact resolution order between `row`/`col`, percentage, and `anchor`.

## Common tasks

- **New slash command / autocomplete entry**: extend the list passed to `CombinedAutocompleteProvider`, don't hand-roll autocomplete matching.
- **Cancellable async work with a spinner**: use `CancellableLoader` (extends `Loader` with an `AbortSignal` wired to Escape) instead of a plain `Loader` + manual key handling.
- **Debugging rendering/flicker issues**: set `PI_TUI_WRITE_LOG=/path/to/log` to capture the raw ANSI stream and inspect what was actually written to stdout.
- **Testing without a real terminal**: use `VirtualTerminal` (backed by `@xterm/headless`) instead of `ProcessTerminal`.

## When something looks like it should exist but you're not sure of the signature

Check `references/api-reference.md` first — it has full constructor signatures, theme interfaces (`EditorTheme`, `MarkdownTheme`, `SelectListTheme`, `SettingsListTheme`, `ImageTheme`), and the `Terminal` interface for custom transports. Don't guess at option shapes for `Editor`, `Markdown`, or `Image` — they take positional args in a specific order (padding before theme before options, generally), and getting the order wrong fails silently or mis-styles output rather than throwing.