import {
  CombinedAutocompleteProvider,
  Editor,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";
import { createEditorTheme } from "../themes/pi-tui.theme.js";
import { formatBinding, matchesBinding } from "../keybindings.js";
import { Card } from "./card.js";
import type { SlashCommandSuggestion } from "@cube/runtime";

export interface PromptEditorOptions {
  tui: TUI;
  onSubmit: (text: string) => void | Promise<void>;
  slashCommands?: SlashCommandSuggestion[];
  basePath?: string;
  initialHistory?: string[];
}

export class PromptEditor implements Component, Focusable {
  private readonly editor: Editor;
  private readonly card: Card;
  private readonly tui: TUI;
  private readonly queuedPrompts: string[] = [];
  private readonly history: string[] = [];
  private historyIndex: number = -1;
  private currentDraft: string = "";
  private isBright: boolean = true;
  private cursorBlinkingEnabled: boolean = true;
  private blinkTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(options: PromptEditorOptions) {
    this.tui = options.tui;
    const theme = createEditorTheme();
    this.editor = new Editor(
      options.tui,
      {
        ...theme,
        borderColor: () => "",
        selectList: {
          ...theme.selectList,
          selectedPrefix: (s) => appTheme.ui.primary.bold(s.replace(/^→ /, "/")),
          selectedText: (s) => appTheme.ui.primary.bold(s.replace(/^→ /, "/")),
          scrollInfo: () => "",
        },
      },
      { paddingX: 0, autocompleteMaxVisible: 8 },
    );
    this.card = new Card({
      render: (width) => this.renderEditor(width),
      invalidate: () => this.editor.invalidate(),
    });

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

      void options.onSubmit(trimmed);
      this.editor.setText("");
    };

    this.startBlinking();
  }

  private startBlinking(): void {
    this.stopBlinking();
    this.isBright = true;
    if (!this.cursorBlinkingEnabled) return;
    this.blinkTimer = setInterval(() => {
      if (!this.focused || !this.cursorBlinkingEnabled) return;
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
    if (!this.cursorBlinkingEnabled) return;
    this.idleTimer = setTimeout(() => {
      if (this.focused && this.cursorBlinkingEnabled) {
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

  setCursorBlinking(enabled: boolean): void {
    if (this.cursorBlinkingEnabled === enabled) return;
    this.cursorBlinkingEnabled = enabled;
    if (enabled && this.focused) {
      this.startBlinking();
      return;
    }

    this.stopBlinking();
    if (!this.isBright) {
      this.isBright = true;
      this.tui.requestRender();
    }
  }

  private renderEditor(width: number): string[] {
    // Native Editor always emits two border rows; the empty border theme removes only those.
    let lines = this.editor.render(Math.max(1, width - 2)).filter((line) => line !== "");
    if (!this.editor.getText() && lines[0]) {
      lines[0] = lines[0].trimEnd() + appTheme.ui.muted("Ask Cube to do anything");
    }

    if (!this.isBright && this.focused) {
      lines = lines.map((line) =>
        line.replace(/\x1b\[7m(.*?)\x1b\[0m/g, "\x1b[48;5;239;37m$1\x1b[0m"),
      );
    }

    if (this.editor.isShowingAutocomplete()) {
      const editorLineCount = Math.max(1, this.editor.getLines().length);
      lines = lines
        .filter((line, index) => {
          if (index >= editorLineCount && (line.trim() === "" || /\(\d+\/\d+\)/.test(line))) {
            return false;
          }
          return true;
        })
        .map((line, index) => {
          if (index >= editorLineCount) {
            return line.replace(/^(\x1b\[[0-9;]*m)? {2}/, "$1/");
          }
          return line;
        });

      if (lines.length > editorLineCount) {
        lines.splice(editorLineCount, 0, "");
      }
    }

    lines = lines.map((line, index) => {
      if (!line) return "";
      return truncateToWidth(`${index === 0 ? appTheme.ui.primary("❯ ") : "  "}${line}`, width);
    });
    return lines;
  }

  render(width: number): string[] {
    const boxLines = this.card.render(width);
    if (this.queuedPrompts.length === 0) return boxLines;

    const queueLines = wrapTextWithAnsi(
      appTheme.ui.muted(
        `• Messages to be submitted after the current turn (${formatBinding("cube.turn.interrupt")} to cancel next queued prompt)`,
      ),
      width,
    );
    for (const prompt of this.queuedPrompts) {
      queueLines.push(
        ...wrapTextWithAnsi(
          `${appTheme.ui.primary("  ↳")} ${appTheme.role.assistant(prompt.replace(/\r?\n/g, " "))}`,
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

  popQueuedPrompt(): string | undefined {
    return this.queuedPrompts.pop();
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
