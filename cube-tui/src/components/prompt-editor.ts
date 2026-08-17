import {
  CombinedAutocompleteProvider,
  CURSOR_MARKER,
  Editor,
  Key,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import type { SlashCommandSuggestion, TuiAction } from "../index.js";
import { createEditorTheme } from "../themes/pi-tui.theme.js";

export interface PromptEditorOptions {
  tui: TUI;
  onAction: (action: TuiAction) => void;
  slashCommands: SlashCommandSuggestion[];
  basePath: string;
}

const INVERSE_ON = "\x1b[7m";
const SGR_RESET = "\x1b[0m";

export const removeSoftwareCursorAfterMarker = (line: string): string => {
  const markerIndex = line.indexOf(CURSOR_MARKER);
  if (markerIndex < 0) return line;

  const inverseIndex = markerIndex + CURSOR_MARKER.length;
  if (!line.startsWith(INVERSE_ON, inverseIndex)) return line;

  const resetIndex = line.indexOf(SGR_RESET, inverseIndex + INVERSE_ON.length);
  if (resetIndex < 0) return line;

  return `${line.slice(0, inverseIndex)}${line.slice(
    inverseIndex + INVERSE_ON.length,
    resetIndex,
  )}${line.slice(resetIndex + SGR_RESET.length)}`;
};

export class PromptEditor extends Editor {
  private isVisible = true;

  setVisible(visible: boolean): void {
    this.isVisible = visible;
  }

  constructor(private readonly options: PromptEditorOptions) {
    super(options.tui, createEditorTheme(), {
      paddingX: 1,
      autocompleteMaxVisible: 8,
    });

    this.setAutocompleteProvider(new CombinedAutocompleteProvider(
      options.slashCommands.map(({ name, description }) => ({
        name: name.slice(1),
        description,
      })),
      options.basePath,
    ));

    this.onSubmit = (text) => {
      const value = text.trim();
      if (!value) return;

      this.addToHistory(value);
      if (value.startsWith("/")) {
        const [name, ...argumentParts] = value.split(/\s+/);
        this.options.onAction({
          type: "command_submit",
          name: name as `/${string}`,
          argument: argumentParts.join(" "),
        });
      } else {
        this.options.onAction({ type: "prompt_submit", content: value });
      }
      this.setText("");
    };
  }

  override handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c"))) {
      this.options.onAction({ type: "cancel" });
      return;
    }
    super.handleInput(data);
  }

  override render(width: number): string[] {
    if (!this.isVisible) return [];
    return super.render(width).map(removeSoftwareCursorAfterMarker);
  }
}
