import {
  CombinedAutocompleteProvider,
  Editor,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { createEditorTheme } from "../themes/pi-tui.theme.js";
import type { SlashCommandSuggestion, TuiAction } from "../index.js";

export interface PromptEditorOptions {
  tui: TUI;
  onAction: (action: TuiAction) => void;
  slashCommands?: SlashCommandSuggestion[];
  basePath?: string;
}

export class PromptEditor implements Component, Focusable {
  private readonly editor: Editor;

  constructor(options: PromptEditorOptions) {
    const theme = createEditorTheme();
    this.editor = new Editor(options.tui, theme);

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

      if (trimmed.startsWith("/")) {
        const spaceIndex = trimmed.indexOf(" ");
        const name = (spaceIndex === -1
          ? trimmed
          : trimmed.slice(0, spaceIndex)) as `/${string}`;
        const argument =
          spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

        options.onAction({
          type: "command_submit",
          name,
          argument,
        });
      } else {
        options.onAction({
          type: "prompt_submit",
          content: trimmed,
        });
      }
      this.editor.setText("");
    };
  }

  get focused(): boolean {
    return this.editor.focused;
  }

  set focused(value: boolean) {
    this.editor.focused = value;
  }

  render(width: number): string[] {
    return this.editor.render(width);
  }

  handleInput(data: string): void {
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
}
