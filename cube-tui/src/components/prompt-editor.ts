import {
  CombinedAutocompleteProvider,
  Editor,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";
import { createEditorTheme } from "../themes/pi-tui.theme.js";
import { formatBinding, matchesBinding } from "../keybindings.js";
import { KeyHint } from "./key-hint.js";
import type { SlashCommandSuggestion, CubeUIAction } from "../index.js";

export interface PromptEditorOptions {
  tui: TUI;
  onAction: (action: CubeUIAction) => void;
  slashCommands?: SlashCommandSuggestion[];
  basePath?: string;
  initialHistory?: string[];
}

export class PromptEditor implements Component, Focusable {
  private readonly editor: Editor;
  private readonly tui: TUI;
  private readonly autocompleteHint: KeyHint;
  private readonly queuedPrompts: string[] = [];
  private readonly history: string[] = [];
  private historyIndex: number = -1;
  private currentDraft: string = "";
  private isBright: boolean = true;
  private blinkTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(options: PromptEditorOptions) {
    this.tui = options.tui;
    const theme = createEditorTheme();
    this.editor = new Editor(options.tui, theme);
    this.editor.setPaddingX(3);
    this.autocompleteHint = new KeyHint([
      { key: "↑/↓", label: "Navigate" },
      { key: "Enter", label: "Select" },
      { key: "Tab", label: "Complete" },
    ]);

    if (options.initialHistory && options.initialHistory.length > 0) {
      this.history.push(...options.initialHistory);
    }

    if (options.slashCommands && options.slashCommands.length > 0) {
      const autocompleteCommands = options.slashCommands.map((cmd) => ({
        name: cmd.name.startsWith("/") ? cmd.name.slice(1) : cmd.name,
        description: cmd.description,
      }));
      const provider = new CombinedAutocompleteProvider(
        autocompleteCommands,
        options.basePath ?? process.cwd(),
      );
      this.editor.setAutocompleteProvider(provider);
    }

    this.editor.onSubmit = (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (this.history[this.history.length - 1] !== trimmed) {
        this.history.push(trimmed);
      }
      this.historyIndex = -1;
      this.currentDraft = "";

      if (trimmed.startsWith("/")) {
        const spaceIndex = trimmed.indexOf(" ");
        const name = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)) as `/${string}`;
        const argument = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

        options.onAction({
          type: "command:submit",
          name,
          argument,
        });
      } else {
        options.onAction({
          type: "prompt:submit",
          content: trimmed,
        });
      }
      this.editor.setText("");
    };

    this.startBlinking();
  }

  private startBlinking(): void {
    this.stopBlinking();
    this.isBright = true;
    this.blinkTimer = setInterval(() => {
      if (!this.focused) return;
      this.isBright = !this.isBright;
      this.tui.requestRender();
    }, 530);
    this.blinkTimer.unref?.();
  }

  private stopBlinking(): void {
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private onUserTyping(): void {
    this.isBright = true;
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      if (this.focused) {
        this.startBlinking();
      }
    }, 500);
    this.idleTimer.unref?.();
  }

  get focused(): boolean {
    return this.editor.focused;
  }

  set focused(value: boolean) {
    this.editor.focused = value;
    if (value) {
      this.startBlinking();
    } else {
      this.stopBlinking();
    }
  }

  render(width: number): string[] {
    const theme = getTheme();
    const innerWidth = Math.max(10, width - 2);
    let lines = this.editor.render(innerWidth);

    if (!this.isBright && this.focused) {
      lines = lines.map((line) =>
        line.replace(/\x1b\[7m(.*?)\x1b\[0m/g, "\x1b[48;5;239;37m$1\x1b[0m"),
      );
    }

    const prefix = theme.user(" ❯ ");
    if (lines.length >= 3 && lines[1]) {
      if (lines[1].startsWith("   ")) {
        lines[1] = `${prefix}${lines[1].slice(3)}`;
      } else if (lines[1].startsWith("  ")) {
        lines[1] = `${prefix}${lines[1].slice(2)}`;
      } else if (lines[1].startsWith(" ")) {
        lines[1] = `${prefix}${lines[1].slice(1)}`;
      }
    }

    // Find the bottom border line of the editor
    let bottomBorderIndex = -1;
    for (let i = lines.length - 1; i >= 1; i--) {
      if (lines[i].includes("─") || lines[i].includes("↓")) {
        bottomBorderIndex = i;
        break;
      }
    }
    if (bottomBorderIndex === -1) {
      bottomBorderIndex = lines.length - 1;
    }

    const borderStyle = this.focused ? theme.primary : theme.border;
    const boxLines: string[] = [];

    // 1. Top border with rounded corners: ╭────────────────╮
    const topContent = lines[0] || "";
    if (topContent.includes("↑")) {
      boxLines.push(borderStyle("╭") + topContent.slice(1, -1) + borderStyle("╮"));
    } else {
      boxLines.push(borderStyle(`╭${"─".repeat(innerWidth)}╮`));
    }

    // 2. Middle content lines with side borders: │ ... │
    for (let i = 1; i < bottomBorderIndex; i++) {
      const content = lines[i] ?? "";
      boxLines.push(`${borderStyle("│")}${content}${borderStyle("│")}`);
    }

    // 3. Bottom border with rounded corners: ╰────────────────╯
    const bottomContent = lines[bottomBorderIndex] || "";
    if (bottomContent.includes("↓")) {
      boxLines.push(borderStyle("╰") + bottomContent.slice(1, -1) + borderStyle("╯"));
    } else {
      boxLines.push(borderStyle(`╰${"─".repeat(innerWidth)}╯`));
    }

    // 4. Autocomplete suggestion lines (if open)
    if (this.editor.isShowingAutocomplete()) {
      for (let i = bottomBorderIndex + 1; i < lines.length; i++) {
        boxLines.push(lines[i]);
      }
      boxLines.push(...this.autocompleteHint.render(innerWidth));
    }

    if (this.queuedPrompts.length === 0) return boxLines;

    const queueLines = wrapTextWithAnsi(
      theme.muted(
        `• Messages to be submitted after the current turn (${formatBinding("cube.turn.interrupt")} to cancel next queued prompt)`,
      ),
      width,
    );
    for (const prompt of this.queuedPrompts) {
      queueLines.push(
        ...wrapTextWithAnsi(
          `${theme.secondary("  ↳")} ${theme.assistant(prompt.replace(/\r?\n/g, " "))}`,
          width,
        ),
      );
    }
    queueLines.push("");
    return [...queueLines, ...boxLines];
  }

  handleInput(data: string): void {
    this.onUserTyping();
    if (matchesBinding(data, "cube.history.previous") && !this.editor.isShowingAutocomplete()) {
      const currentText = this.editor.getText();
      const isSingleLine = !currentText.includes("\n");
      const cursor = this.editor.getCursor();

      if (isSingleLine || cursor.line === 0) {
        if (this.history.length > 0) {
          if (this.historyIndex === -1) {
            this.currentDraft = currentText;
            this.historyIndex = this.history.length - 1;
          } else if (this.historyIndex > 0) {
            this.historyIndex--;
          }
          const item = this.history[this.historyIndex];
          if (item !== undefined) {
            this.editor.setText(item);
            this.editor.invalidate?.();
          }
          return;
        }
      }
    }

    if (matchesBinding(data, "cube.history.next") && !this.editor.isShowingAutocomplete()) {
      if (this.historyIndex !== -1) {
        if (this.historyIndex < this.history.length - 1) {
          this.historyIndex++;
          const item = this.history[this.historyIndex];
          if (item !== undefined) {
            this.editor.setText(item);
            this.editor.invalidate?.();
          }
        } else {
          this.historyIndex = -1;
          this.editor.setText(this.currentDraft);
          this.editor.invalidate?.();
        }
        return;
      }
    }

    if (this.historyIndex !== -1 && data !== "\u001b[C" && data !== "\u001b[D") {
      this.historyIndex = -1;
    }

    this.editor.handleInput(data);
  }

  invalidate(): void {
    this.editor.invalidate?.();
  }

  setText(text: string): void {
    this.editor.setText(text);
  }

  getText(): string {
    return this.editor.getText();
  }

  enqueueQueuedPrompt(content: string): void {
    this.queuedPrompts.push(content);
  }

  prependQueuedPrompt(content: string): void {
    this.queuedPrompts.unshift(content);
  }

  dequeueQueuedPrompt(): string | undefined {
    return this.queuedPrompts.shift();
  }

  dequeueQueuedPrompts(count: number): string[] {
    return this.queuedPrompts.splice(0, Math.max(0, count));
  }

  clearQueuedPrompts(): void {
    this.queuedPrompts.length = 0;
  }

  getQueuedPromptCount(): number {
    return this.queuedPrompts.length;
  }
}
