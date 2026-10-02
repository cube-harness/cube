import {
  CombinedAutocompleteProvider,
  fuzzyFilter,
  type AutocompleteProvider,
  Editor,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";
import { createEditorTheme } from "../themes/pi-tui.theme.js";
import { formatBinding, matchesBinding } from "../keybindings.js";
import { Card } from "./card.js";
import type { SkillChoice, SlashCommandSuggestion } from "@cube/runtime";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface PromptEditorOptions {
  tui: TUI;
  onSubmit: (text: string) => void | Promise<void>;
  slashCommands?: SlashCommandSuggestion[];
  basePath?: string;
  initialHistory?: string[];
  getSkills?: () => Promise<SkillChoice[]>;
}

export function createPromptAutocomplete(
  basePath: string, commands: SlashCommandSuggestion[] = [],
  getSkills: () => Promise<SkillChoice[]> = async () => [],
): AutocompleteProvider {
  const native = new CombinedAutocompleteProvider(commands.map((command) => ({
    name: command.name.slice(1), description: command.description,
  })), basePath);
  const inside = (root: string, path: string) => {
    const rel = relative(root, path);
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../");
  };
  return {
    triggerCharacters: ["/", "@", "$"],
    async getSuggestions(lines, row, col, options) {
      const before = (lines[row] ?? "").slice(0, col);
      const mention = before.match(/(?:^|[\s([{])(\$[\w-]*)$/)?.[1];
      if (mention) {
        const choices = (await getSkills()).filter((skill) => skill.enabled && skill.userInvocable);
        const unique = choices.filter((skill, index) => choices.findIndex((other) => other.name === skill.name) === index);
        const items = fuzzyFilter(unique, mention.slice(1), (skill) => skill.name).map((skill) => ({
          value: `$${skill.name}`, label: `$${skill.name}`, description: skill.description,
        }));
        return items.length ? { items, prefix: mention } : null;
      }
      if (/^\/[^/\s]*$/.test(before)) {
        const result = await native.getSuggestions(lines, row, col, { ...options, force: false });
        return result && { ...result, items: result.items.map((item) => ({ ...item, label: `/${item.value}` })) };
      }
      const token = before.match(/(?:^|[\s=])(@?"[^"\n]*|[^\s"'=]*)$/)?.[1];
      if (token === undefined) return null;
      const at = token.startsWith("@");
      const raw = token.replace(/^@/, "").replace(/^"/, "").replace(/\\/g, "/");
      if (raw.startsWith("~") || (!at && !options.force && !/[/.]/.test(raw))) return null;
      try {
        const root = await realpath(basePath);
        const target = resolve(basePath, raw || ".");
        if (!inside(resolve(basePath), target)) return null;
        const directory = raw.endsWith("/") || !raw ? target : dirname(target);
        if (!inside(root, await realpath(directory))) return null;
        // Native @ fuzzy search requires fd. Delegate to native directory completion
        // instead: it quotes spaces and needs no executable or recursive symlink walk.
        const local = relative(basePath, target).replace(/\\/g, "/") + (raw.endsWith("/") ? "/" : "");
        const query = `${token.includes('"') ? '"' : ""}${local === "." ? "" : local}`;
        const result = await native.getSuggestions([` ${query}`], 0, query.length + 1, { ...options, force: true });
        if (!result) return null;
        const items = [];
        for (const item of result.items) {
          const path = resolve(basePath, item.value.replace(/^"|"$/g, ""));
          if (inside(root, await realpath(path))) items.push({ ...item, value: `${at ? "@" : ""}${item.value}` });
        }
        return items.length ? { items, prefix: token } : null;
      } catch { return null; }
    },
    applyCompletion(lines, row, col, item, prefix) {
      if (!prefix.startsWith("$")) return native.applyCompletion(lines, row, col, item, prefix);
      const next = [...lines];
      const start = col - prefix.length;
      next[row] = lines[row]!.slice(0, start) + item.value + " " + lines[row]!.slice(col);
      return { lines: next, cursorLine: row, cursorCol: start + item.value.length + 1 };
    },
    shouldTriggerFileCompletion: (...args) => native.shouldTriggerFileCompletion(...args),
  };
}

export class PromptEditor implements Component, Focusable {
  private readonly editor: Editor;
  private readonly card: Card;
  private readonly tui: TUI;
  private readonly queuedPrompts: string[] = [];
  private autocompleteLines: string[] = [];
  private cardStartRow = 0;
  private skillNames = new Set<string>();
  private readonly commandNames: Set<string>;
  private readonly history: string[] = [];
  private historyIndex: number = -1;
  private currentDraft: string = "";
  private isBright: boolean = true;
  private cursorBlinkingEnabled: boolean = true;
  private blinkTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(options: PromptEditorOptions) {
    this.tui = options.tui;
    this.commandNames = new Set(options.slashCommands?.map(({ name }) => name));
    const theme = createEditorTheme();
    this.editor = new Editor(
      options.tui,
      {
        ...theme,
        borderColor: () => "",
        selectList: {
          ...theme.selectList,
          selectedPrefix: (s) => s.replace(/^→ /, "❯ "),
          selectedText: (s) => s.replace(/^→ /, "❯ "),
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

    this.editor.setAutocompleteProvider(createPromptAutocomplete(
      options.basePath ?? process.cwd(), options.slashCommands, async () => {
        const skills = await options.getSkills?.() ?? [];
        this.skillNames = new Set(skills.filter((skill) => skill.enabled && skill.userInvocable)
          .map((skill) => `$${skill.name}`));
        return skills;
      },
    ));

    this.editor.onChange = () => {
      const cursor = this.editor.getCursor();
      const before = this.editor.getLines()[cursor.line]!.slice(0, cursor.col);
      if (!/(?:^|\s)@(?:"[^"\n]*|[^\s"]*)\/$/.test(before)) return;
      const text = this.editor.getText();
      // Native completion closes the menu after selection. Reopen after it finishes;
      // pi-tui 0.84 has no public method for opening suggestions without completing.
      queueMicrotask(() => {
        const current = this.editor.getCursor();
        if (this.editor.getText() !== text || current.line !== cursor.line || current.col !== cursor.col) return;
        (this.editor as unknown as { tryTriggerAutocomplete(): void }).tryTriggerAutocomplete();
      });
    };

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
    // Empty native borders delimit the input and menu, including wrapped/scrolled input.
    const rendered = this.editor.render(Math.max(1, width - 2));
    const bottomBorder = rendered.indexOf("", 1);
    let lines = rendered.slice(1, bottomBorder);
    this.autocompleteLines = rendered.slice(bottomBorder + 1)
      .filter((line) => line.trim() !== "");
    if (!this.editor.getText() && lines[0]) {
      lines[0] = lines[0].trimEnd() + appTheme.ui.muted("Ask Cube to do anything");
    }

    if (!this.isBright && this.focused) {
      lines = lines.map((line) =>
        line.replace(/\x1b\[7m(.*?)\x1b\[0m/g, "\x1b[48;5;239;37m$1\x1b[0m"),
      );
    }

    lines = lines.map((line, index) => {
      if (!line) return "";
      line = line.replace(/(^|[\s([{])([$\/](?:[\w-]|\x1b\[[\d;]*m|\x1b_pi:c\x07)+)/g,
        (match, prefix: string, mention: string) => {
          const name = stripTerminalSequences(mention);
          const highlighted = this.skillNames.has(name) ||
            (index === 0 && !prefix.trim() && this.commandNames.has(name));
          return highlighted
            ? prefix + mention.split("\x1b[0m").map((part) => appTheme.ui.primary(part)).join("\x1b[0m")
            : match;
        });
      return truncateToWidth(`${index === 0 ? appTheme.ui.primary("❯ ") : "  "}${line}`, width);
    });
    return lines;
  }

  render(width: number): string[] {
    const boxLines = this.card.render(width);
    this.cardStartRow = this.autocompleteLines.length;
    const promptLines = [
      ...this.autocompleteLines.map((line) => {
        const row = truncateToWidth(`  ${line}`, width);
        if (!line.startsWith("❯ ")) return row;
        // Truncated descriptions contain SGR resets; clear them before styling the full row.
        const plain = stripTerminalSequences(row);
        return appTheme.ui.selected(plain + " ".repeat(Math.max(0, width - visibleWidth(plain))));
      }),
      ...boxLines,
    ];
    if (this.queuedPrompts.length === 0) return promptLines;

    const queueLines = wrapTextWithAnsi(
      appTheme.ui.muted(
        ` • Messages to be submitted after the current turn (${formatBinding("cube.turn.interrupt")} to cancel next queued prompt)`,
      ),
      width,
    );
    for (const prompt of this.queuedPrompts) {
      queueLines.push(
        ...wrapTextWithAnsi(
          `${appTheme.ui.primary("   ↳")} ${appTheme.role.assistant(prompt.replace(/\r?\n/g, " "))}`,
          width,
        ),
      );
    }
    queueLines.push("");
    this.cardStartRow += queueLines.length;
    return [...queueLines, ...promptLines];
  }

  getCardStartRow(): number { return this.cardStartRow; }

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
