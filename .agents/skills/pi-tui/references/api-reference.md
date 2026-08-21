# pi-tui API Reference

Full reference distilled from the `@earendil-works/pi-tui` README (packages/tui in the `earendil-works/pi` monorepo). Import everything from `"@earendil-works/pi-tui"`.

## Quick Start

```typescript
import { type TUI, Text, Editor, ProcessTerminal, TuiMainScreen, matchesKey } from "@earendil-works/pi-tui";

const terminal = new ProcessTerminal();
const tui: TUI = new TuiMainScreen(terminal);

tui.addChild(new Text("Welcome to my app!"));

import { defaultEditorTheme as editorTheme } from './test/test-themes.ts';
const editor = new Editor(tui, editorTheme);
editor.onSubmit = (text) => {
  console.log("Submitted:", text);
  tui.addChild(new Text(`You said: ${text}`));
};
tui.addChild(editor);
tui.setFocus(editor);

// Raw mode: Ctrl+C doesn't send SIGINT — intercept it yourself
tui.addInputListener((data) => {
  if (matchesKey(data, 'ctrl+c')) {
    tui.stop();
    process.exit(0);
  }
});

tui.start();
```

## TUI interface and renderers

`TUI` is the shared interface for component management, focus, overlays, input, lifecycle, terminal queries, and rendering.

- `TuiMainScreen` — renders into the main terminal buffer, preserves scrollback.
- `TuiAltScreen` — renders a fixed-height viewport in the alternate buffer with app-owned scrolling. Restores the main buffer and prints the complete final document when stopped.

```typescript
import { type TUI, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";

const tui: TUI = new TuiMainScreen(terminal);
// or: const tui: TUI = new TuiAltScreen(terminal);

tui.addChild(component);
tui.removeChild(component);
tui.start();
tui.stop();
tui.requestRender();          // request a re-render
tui.onDebug = () => console.log("Debug triggered");  // Shift+Ctrl+D
```

## Alternate-screen viewport layouts

`TuiAltScreen` can render an explicit terminal-height layout. `VStack`/`HStack` allocate constrained regions, `ScrollView` owns scrolling for one region. Unavailable on `TuiMainScreen` (the terminal owns scrollback there).

```typescript
import { Container, isViewportTUI, ScrollView, Text, VStack } from "@earendil-works/pi-tui";

const transcript = new Container();
transcript.addChild(new Text("History"));

const editorAndFooter = new VStack([editor, new Text("status")]);

if (isViewportTUI(tui)) {
  tui.setLayoutRoot(new VStack([
    {
      component: new ScrollView(transcript, { follow: "end", primary: true, overscroll: "chain" }),
      basis: 0, grow: 1, minSize: 1,
    },
    { component: editorAndFooter, basis: "auto", shrink: 1, minSize: 1 },
  ]));
}
```

Stack entries support `basis`, `grow`, `shrink`, `minSize`, `maxSize`, and responsive `visible` callbacks. Mouse-wheel input targets the scroll view under the pointer; unused delta chains to outer scroll views by default. The primary scroll view gets alt-screen keyboard navigation and wheel input over non-scrollable regions, plus jumps between OSC 133 semantic prompt markers. `Ctrl+Shift+F` searches rendered content, `Enter`/`Ctrl+G` and `Shift+Enter`/`Ctrl+Shift+G` move between matches, `Escape` closes search. `TuiAltScreenOptions.searchMatchStyle` / `searchCurrentMatchStyle` customize highlighting.

Layout geometry rebuilds each requested frame; stateful components and their render-line caches are retained. Calling `render(width)` directly on layout components produces an unbounded document (also used when alt mode restores the main screen).

## Overlays

Render on top of existing content without replacing it — dialogs, menus, modals.

- **Anchors**: `'center'`, `'top-left'`, `'top-right'`, `'bottom-left'`, `'bottom-right'`, `'top-center'`, `'bottom-center'`, `'left-center'`, `'right-center'`
- **Resolution order**: (1) `minWidth` floors the calculated width, (2) absolute `row`/`col` > percentage `row`/`col` > `anchor`, (3) `margin` clamps final position to terminal bounds, (4) `visible` callback (called every frame) controls whether it renders at all.

## Component Interface

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
}
```

- `render(width)` — array of lines; **each line must not exceed `width`** or the TUI errors. Use `truncateToWidth()` or manual wrapping.
- `handleInput?(data)` — called when focused; `data` is raw terminal input (may include ANSI escapes).
- `invalidate?()` — clear cached render state so the next `render()` starts fresh.

The TUI appends a full SGR reset and OSC 8 reset at the end of each rendered line — styles don't carry across lines. For styled multi-line text, reapply per line or use `wrapTextWithAnsi()`.

## Focusable Interface (IME support)

```typescript
import { CURSOR_MARKER, type Component, type Focusable } from "@earendil-works/pi-tui";

class MyInput implements Component, Focusable {
  focused: boolean = false;  // set by TUI when focus changes

  render(width: number): string[] {
    const marker = this.focused ? CURSOR_MARKER : "";
    return [`> ${beforeCursor}${marker}\x1b[7m${atCursor}\x1b[27m${afterCursor}`];
  }
}
```

When a `Focusable` has focus, TUI: sets `focused = true`, scans render output for `CURSOR_MARKER` (a zero-width APC escape), positions the hardware cursor there, and shows it only if `showHardwareCursor` is enabled. The hardware cursor is hidden by default (fake cursor still renders) but some terminals need it visible for IME positioning — enable via the renderer constructor's `showHardwareCursor` arg, `setShowHardwareCursor(true)`, or `PI_HARDWARE_CURSOR=1`. `Editor` and `Input` already implement this.

**Containers with embedded inputs** (dialogs, selectors) must implement `Focusable` themselves and propagate focus to the child, or IME candidate windows position incorrectly:

```typescript
import { Container, type Focusable, Input } from "@earendil-works/pi-tui";

class SearchDialog extends Container implements Focusable {
  private searchInput: Input;
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }
  constructor() {
    super();
    this.searchInput = new Input();
    this.addChild(this.searchInput);
  }
}
```

## Built-in Components

### Container
Groups children. `container.addChild(component)`, `container.removeChild(component)`.

### Box
Container applying padding + background to all children.
```typescript
const box = new Box(1, 1, (text) => chalk.bgGray(text)); // paddingX, paddingY, optional bgFn
box.addChild(new Text("Content"));
box.setBgFn((text) => chalk.bgBlue(text));
```

### Text
Multi-line text with word wrap and padding.
```typescript
const text = new Text("Hello World", 1, 1, (text) => chalk.bgGray(text)); // text, paddingX, paddingY, bgFn
text.setText("Updated text");
text.setCustomBgFn((text) => chalk.bgBlue(text));
```

### TruncatedText
Single-line, truncates to viewport width. Good for status lines/headers.
```typescript
const truncated = new TruncatedText("Long line...", 0, 0); // text, paddingX, paddingY
```

### Input
Single-line, horizontal scrolling.
```typescript
const input = new Input();
input.onSubmit = (value) => console.log(value);
input.setValue("initial");
input.getValue();
```
Keys: `Enter` submit · `Ctrl+A`/`Ctrl+E` line start/end · `Ctrl+W`/`Alt+Backspace` delete word back · `Ctrl+U` delete to start · `Ctrl+K` delete to end · `Ctrl+Left/Right`, `Alt+Left/Right` word nav · arrows/Backspace/Delete as expected.

### Editor
Multi-line, autocomplete, file completion, paste handling, vertical scroll when content exceeds terminal height.
```typescript
interface EditorTheme { borderColor: (str: string) => string; selectList: SelectListTheme; }
interface EditorOptions { paddingX?: number; }

const editor = new Editor(tui, theme, options?); // tui required for height-aware scrolling
editor.onSubmit = (text) => console.log(text);
editor.onChange = (text) => console.log("Changed:", text);
editor.disableSubmit = true;
editor.setAutocompleteProvider(provider);
editor.borderColor = (s) => chalk.blue(s);
editor.setPaddingX(1);
editor.getPaddingX();
```
Features: word wrap, `/` slash-command autocomplete, `Tab` file-path autocomplete, paste >10 lines becomes `[paste #1 +50 lines]` marker, border lines, fake cursor.
Keys: `Enter` submit · `Shift+Enter`/`Ctrl+Enter`/`Alt+Enter` newline (Alt+Enter most reliable across terminals) · `Tab` autocomplete · `Ctrl+K`/`Ctrl+U` delete to end/start · `Ctrl+W`/`Alt+Backspace` delete word back · `Alt+D`/`Alt+Delete` delete word forward · `Ctrl+A`/`Ctrl+E` line start/end · `Ctrl+]` jump forward to char (awaits keypress) · `Ctrl+Alt+]` jump backward · arrows/Backspace/Delete as expected.

### Markdown
Renders markdown with syntax highlighting and theming.
```typescript
interface MarkdownTheme {
  heading: (text: string) => string;
  link: (text: string) => string;
  linkUrl: (text: string) => string;
  code: (text: string) => string;
  codeBlock: (text: string) => string;
  codeBlockBorder: (text: string) => string;
  quote: (text: string) => string;
  quoteBorder: (text: string) => string;
  hr: (text: string) => string;
  listBullet: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
  underline: (text: string) => string;
  highlightCode?: (code: string, lang?: string) => string[];
}
interface DefaultTextStyle {
  color?: (text: string) => string;
  bgColor?: (text: string) => string;
  bold?: boolean; italic?: boolean; strikethrough?: boolean; underline?: boolean;
}

const md = new Markdown("# Hello\n\nSome **bold** text", 1, 1, theme, defaultStyle);
// text, paddingX, paddingY, MarkdownTheme, optional DefaultTextStyle
md.setText("Updated markdown");
```
Features: headings/bold/italic/code blocks/lists/links/blockquotes, HTML tags rendered as plain text, optional `highlightCode`, padding, render caching.

### Loader
```typescript
const loader = new Loader(tui, (s) => chalk.cyan(s), (s) => chalk.gray(s), "Loading...");
// tui, spinnerColorFn, messageColorFn, message
loader.start();
loader.setMessage("Still loading...");
loader.stop();
```

### CancellableLoader
Extends `Loader` with Escape handling + `AbortSignal`.
```typescript
const loader = new CancellableLoader(tui, (s) => chalk.cyan(s), (s) => chalk.gray(s), "Working...");
loader.onAbort = () => done(null);
doAsyncWork(loader.signal).then(done);
```
Properties: `signal: AbortSignal`, `aborted: boolean`, `onAbort?: () => void`.

### SelectList
```typescript
interface SelectItem { value: string; label: string; description?: string; }
interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

const list = new SelectList(
  [{ value: "opt1", label: "Option 1", description: "First option" }, /* ... */],
  5,      // maxVisible
  theme,
);
list.onSelect = (item) => console.log("Selected:", item);
list.onCancel = () => console.log("Cancelled");
list.onSelectionChange = (item) => console.log("Highlighted:", item);
list.setFilter("opt");
```
Controls: arrows navigate, Enter select, Escape cancel.

### SettingsList
```typescript
interface SettingItem {
  id: string; label: string; description?: string; currentValue: string;
  values?: string[]; // Enter/Space cycles through these if provided
  submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}
interface SettingsListTheme {
  label: (text: string, selected: boolean) => string;
  value: (text: string, selected: boolean) => string;
  description: (text: string) => string;
  cursor: string;
  hint: (text: string) => string;
}

const settings = new SettingsList(
  [
    { id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
    { id: "model", label: "Model", currentValue: "gpt-4", submenu: (val, done) => modelSelector },
  ],
  10, theme,
  (id, newValue) => console.log(`${id} changed to ${newValue}`),
  () => console.log("Cancelled"),
);
settings.updateValue("theme", "light");
```
Controls: arrows navigate, Enter/Space activate (cycle value or open submenu), Escape cancel.

### Spacer
```typescript
const spacer = new Spacer(2); // empty lines, default 1
```

### Image
Renders inline for terminals supporting Kitty graphics protocol (Kitty, Ghostty, WezTerm) or iTerm2 inline images; falls back to a text placeholder otherwise.
```typescript
interface ImageTheme { fallbackColor: (str: string) => string; }
interface ImageOptions { maxWidthCells?: number; maxHeightCells?: number; filename?: string; }

const image = new Image(base64Data, "image/png", theme, options);
tui.addChild(image);
```
Supported formats: PNG, JPEG, GIF, WebP (dimensions parsed from headers automatically).

**Alt-screen image compatibility**: `TuiAltScreen` supports inline images and partial viewport cropping in Kitty-protocol terminals (Kitty, Ghostty). iTerm2's protocol can't delete/crop placements while scrolling, so `TuiAltScreen` renders iTerm2 images as text placeholders to avoid stale images; `TuiMainScreen` still renders iTerm2 inline images normally.

## Autocomplete

### CombinedAutocompleteProvider
Slash commands + file paths.
```typescript
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

const provider = new CombinedAutocompleteProvider(
  [
    { name: "help", description: "Show help" },
    { name: "clear", description: "Clear screen" },
    { name: "delete", description: "Delete last message" },
  ],
  process.cwd(), // base path for file completion
);

editor.setAutocompleteProvider(provider);
```
Features: `/` shows slash commands, `Tab` file-path completion, works with `~/`, `./`, `../`, `@` prefix (filters to attachable files).

## Key Detection

```typescript
import { matchesKey, Key } from "@earendil-works/pi-tui";

if (matchesKey(data, Key.ctrl("c"))) process.exit(0);
if (matchesKey(data, Key.enter)) submit();
else if (matchesKey(data, Key.escape)) cancel();
else if (matchesKey(data, Key.up)) moveUp();
```
Supports Kitty keyboard protocol. Identifiers: `Key.enter`, `Key.escape`, `Key.tab`, `Key.space`, `Key.backspace`, `Key.delete`, `Key.home`, `Key.end`, `Key.up/down/left/right`, modifiers via `Key.ctrl("c")`, `Key.shift("tab")`, `Key.alt("left")`, `Key.ctrlShift("p")`. String literals also work: `"enter"`, `"ctrl+c"`, `"shift+tab"`, `"ctrl+shift+p"`.

## Rendering modes

`TuiMainScreen` uses three strategies: (1) first render — output all lines without clearing scrollback, (2) width changed or a change above the viewport — clear screen and fully re-render, (3) normal update — move cursor to first changed line, clear to end, render changed lines.

`TuiAltScreen` owns a terminal-height viewport. Without an explicit layout root it preserves legacy single-document scrolling. With `setLayoutRoot()`, `VStack`/`HStack`/nested `ScrollView` reserve fixed regions and scroll independently. It updates changed viewport rows in place, follows streaming output at the bottom, preserves manual scroll position as content grows. Mouse-wheel and keyboard navigation scroll without touching terminal scrollback, including OSC 133 prompt-marker jumps. Clicking an OSC 8 hyperlink opens it via the configured URL handler. Dragging with the primary mouse button selects text and copies via OSC 52; holding a drag at a scroll view's edge auto-scrolls and extends selection off-screen. Kitty images support vertical viewport cropping; iTerm2 images fall back to text (protocol can't delete/crop during repaint).

Both renderers wrap updates in synchronized output (`\x1b[?2026h` ... `\x1b[?2026l`) for atomic, flicker-free rendering.

## Terminal Interface

```typescript
interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  write(data: string): void;
  get columns(): number;
  get rows(): number;
  moveBy(lines: number): void;
  hideCursor(): void;
  showCursor(): void;
  clearLine(): void;
  clearFromCursor(): void;
  clearScreen(): void;
}
```
Built-in implementations: `ProcessTerminal` (uses `process.stdin`/`stdout`), `VirtualTerminal` (testing, backed by `@xterm/headless`).

## Utilities

```typescript
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const width = visibleWidth("\x1b[31mHello\x1b[0m"); // 5 — ignores ANSI codes

const truncated = truncateToWidth("Hello World", 8); // "Hello..." — preserves ANSI, adds ellipsis
const truncatedNoEllipsis = truncateToWidth("Hello World", 8, ""); // "Hello Wo"

const lines = wrapTextWithAnsi("This is a long line that needs wrapping", 20);
// ["This is a long line", "that needs wrapping"] — preserves ANSI across breaks
```

## Creating Custom Components

Each `render()` line must not exceed `width`, or the TUI errors.

### Handling Input
```typescript
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

class MyInteractiveComponent implements Component {
  private selectedIndex = 0;
  private items = ["Option 1", "Option 2", "Option 3"];
  public onSelect?: (index: number) => void;
  public onCancel?: () => void;

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
    } else if (matchesKey(data, Key.enter)) {
      this.onSelect?.(this.selectedIndex);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    }
  }

  render(width: number): string[] {
    return this.items.map((item, i) => {
      const prefix = i === this.selectedIndex ? "> " : "  ";
      return truncateToWidth(prefix + item, width);
    });
  }
}
```

### Handling Line Width
```typescript
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

class MyComponent implements Component {
  constructor(private text: string) {}

  render(width: number): string[] {
    // Option 1: truncate
    return [truncateToWidth(this.text, width)];

    // Option 2: check and pad to exact width (for backgrounds)
    const visible = visibleWidth(this.text);
    if (visible > width) return [truncateToWidth(this.text, width)];
    return [this.text + " ".repeat(width - visible)];
  }
}
```

### ANSI Code Considerations
`visibleWidth()` ignores ANSI codes when measuring; `truncateToWidth()` preserves ANSI codes and properly closes them when truncating.
```typescript
import chalk from "chalk";
const styled = chalk.red("Hello") + " " + chalk.blue("World");
const width = visibleWidth(styled); // 11
const truncated = truncateToWidth(styled, 8); // red "Hello" + " W..." with proper reset
```

### Caching
```typescript
class CachedComponent implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];
  constructor(private text: string) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const lines = [truncateToWidth(this.text, width)];
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

## Additional Utilities (not in main README, verified against package .d.ts)

### Fuzzy matching
```typescript
interface FuzzyMatch { matches: boolean; score: number; } // lower score = better match

function fuzzyMatch(query: string, text: string): FuzzyMatch;
// Matches if all query chars appear in order (not necessarily consecutive).

function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[];
// Filters + sorts by match quality (best first). Supports whitespace/slash-separated
// tokens in query -- all tokens must match.
```

### Keybindings registry
```typescript
type Keybinding = keyof Keybindings; // e.g. "tui.editor.cursorUp", "tui.select.confirm", "tui.altScreen.search"
interface KeybindingDefinition { defaultKeys: KeyId | KeyId[]; description?: string; }
type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>; // user overrides

class KeybindingsManager {
  constructor(definitions: KeybindingDefinitions, userBindings?: KeybindingsConfig);
  matches(data: string, keybinding: Keybinding): boolean;
  getKeys(keybinding: Keybinding): KeyId[];
  getDefinition(keybinding: Keybinding): KeybindingDefinition;
  getConflicts(): KeybindingConflict[];
  setUserBindings(userBindings: KeybindingsConfig): void;
  getUserBindings(): KeybindingsConfig;
  getResolvedBindings(): KeybindingsConfig;
}

function setKeybindings(keybindings: KeybindingsManager): void; // register globally
function getKeybindings(): KeybindingsManager;                   // read back globally
const TUI_KEYBINDINGS: KeybindingDefinitions;
// Built-in defaults for every editor/select/alt-screen action, e.g.:
//   "tui.editor.cursorUp": { defaultKeys: "up", description: "Move cursor up" }
//   "tui.select.confirm":  { defaultKeys: "enter", description: "Confirm selection" }
//   "tui.altScreen.search": { defaultKeys: "ctrl+shift+f", description: "Search the primary scroll view" }
// Built-in components (Editor, SelectList, TuiAltScreen navigation) already read these.
// Extend via declaration merging on the `Keybindings` interface for custom actions.
```

### LaTeX rendering
```typescript
interface RenderLatexOptions { display?: boolean; } // stack fractions/limits vertically

function renderLatex(source: string, options?: RenderLatexOptions): string | undefined;
// Basic LaTeX math -> terminal-friendly Unicode. Returns undefined on unsupported/malformed
// syntax -- always handle that case (fall back to raw source).
```

### Hyperlinks (OSC 8)
```typescript
function hyperlink(text: string, url: string): string;
// Wraps text in an OSC 8 escape sequence -- supporting terminals render text as clickable,
// opening url. Use instead of hand-building the escape sequence or printing raw URLs.

function getOsc8LinkAtColumn(line: string, column: number): string | undefined;
// Given a rendered line + column (e.g. from a mouse click), returns the OSC 8 URL there, if any.
```

### Lower-level text utilities
```typescript
function sliceByColumn(line: string, startCol: number, length: number, strict?: boolean): string;
// Extract a visible-column sub-range of a styled line (handles ANSI + wide chars).
// Use over truncateToWidth() when you need a middle slice, not just a start-truncated prefix.

function stripTerminalSequences(str: string): string;
// Removes ANSI/OSC/APC control sequences, keeping visible text. Use for plain-text
// comparison/search/copy -- not for anything meant to still be displayed styled.
```

### Low-level image encoding (Image component wraps all of this -- use Image unless building a custom image component)
```typescript
function detectCapabilities(tmuxForwardsHyperlink?: () => boolean): TerminalCapabilities;
function getCapabilities(): TerminalCapabilities;
function encodeKitty(base64Data: string, options?: {...}): string;
function encodeITerm2(base64Data: string, options?: {...}): string;
function renderImage(base64Data: string, imageDimensions: ImageDimensions, options?: ImageRenderOptions): {...};
function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string;
function getImageDimensions(...): ImageDimensions; // + per-format: getPngDimensions, getJpegDimensions, getGifDimensions, getWebpDimensions
```

### Markdown parser (re-export)
```typescript
import { Marked } from "@earendil-works/pi-tui"; // re-exported from the `marked` npm package
// The parser underlying the Markdown component. Use directly if you need markdown tokens
// without rendering them as a TUI component.
```