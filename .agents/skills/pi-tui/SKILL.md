---
name: pi-tui
description: Build or modify terminal UI (TUI) applications using the @earendil-works/pi-tui TypeScript library — a differential-rendering framework for flicker-free CLI apps (chat interfaces, coding agent UIs, interactive prompts). Use this whenever the user is working on a CLI/terminal interface with pi-tui, mentions components like Editor, SelectList, Markdown, Container, VStack/HStack, ScrollView, TuiMainScreen/TuiAltScreen, or is building something like a cube-tui package. Also use when the user hits rendering bugs (flicker, wrong cursor position, lines exceeding width, IME issues) in a pi-tui-based app, or asks how to add a new component, overlay, or keybinding to a terminal UI built on this library.
---

# pi-tui

`@earendil-works/pi-tui` (formerly `@mariozechner/pi-tui`, now deprecated — always use the `@earendil-works` scope) is a minimal terminal UI framework built around differential rendering: components return arrays of lines, and the renderer only repaints what changed. It's the TUI layer used by the `pi` coding agent CLI, and is a good fit for chat-style or dashboard-style terminal apps.

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