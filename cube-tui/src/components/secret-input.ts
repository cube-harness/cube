import {
  CURSOR_MARKER,
  Input,
  Text,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";
import { formatBinding } from "../keybindings.js";
import { KeyHint } from "./key-hint.js";

export type SecretInputOptions = {
  title: string;
  initialValue?: string;
  masked?: boolean;
  onSubmit(value: string): void;
  onCancel(): void;
};

export class SecretInput implements Component, Focusable {
  private readonly input = new Input();
  private readonly title: Text;
  private readonly hint = new KeyHint([
    { key: formatBinding("tui.select.confirm"), label: "Confirm" },
    { key: formatBinding("tui.select.cancel"), label: "Cancel" },
  ]);

  constructor(private readonly options: SecretInputOptions) {
    this.title = new Text(appTheme.ui.text.bold(options.title), 0, 0);
    if (options.initialValue) {
      this.input.setValue(options.initialValue);
      this.input.handleInput("\x05");
    }
    this.input.onSubmit = (value) => {
      if (value.trim()) options.onSubmit(value.trim());
    };
    this.input.onEscape = options.onCancel;
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  render(width: number): string[] {
    const input = this.options.masked === false
      ? this.input.render(width)
      : [truncateToWidth(
          "❯ " + "•".repeat([...this.input.getValue()].length) +
            (this.focused ? CURSOR_MARKER : ""),
          width,
        )];
    return [
      ...this.title.render(width),
      appTheme.ui.muted(this.options.masked === false ? "Enter endpoint:" : "Paste key:"),
      "",
      ...input,
      "",
      ...this.hint.render(width),
    ];
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  invalidate(): void {
    this.title.invalidate();
    this.hint.invalidate();
    this.input.invalidate();
  }
}
