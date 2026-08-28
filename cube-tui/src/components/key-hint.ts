import { Text, type Component } from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";

export interface KeyHintItem {
  key: string;
  label: string;
}

export class KeyHint implements Component {
  private readonly text: Text;

  constructor(items: KeyHintItem[] = []) {
    this.text = new Text("", 0, 0);
    this.setHints(items);
  }

  setHints(items: KeyHintItem[]): void {
    const formatted = items
      .map((item) => `${item.key}: ${item.label}`)
      .join(" • ");
    this.text.setText(appTheme.ui.muted(formatted));
  }

  invalidate(): void {
    this.text.invalidate();
  }

  render(width: number): string[] {
    return this.text.render(width);
  }
}
