import { Text, type Component } from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";

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
    const theme = getTheme();
    const formatted = items
      .map((item) => `${item.key}: ${item.label}`)
      .join(" • ");
    this.text.setText(theme.muted(formatted));
  }

  invalidate(): void {
    this.text.invalidate();
  }

  render(width: number): string[] {
    return this.text.render(width);
  }
}
