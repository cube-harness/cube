import {
  Text,
  CURSOR_MARKER,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";

export interface SearchBarOptions {
  placeholder?: string;
  prefix?: string;
  initialQuery?: string;
}

export class SearchBar implements Component, Focusable {
  focused = true;
  private query = "";
  private readonly placeholder: string;
  private readonly prefix: string;
  private readonly text: Text;

  constructor(options: SearchBarOptions = {}) {
    this.placeholder = options.placeholder ?? "Type to filter...";
    this.prefix = options.prefix ?? "Search: ";
    this.query = options.initialQuery ?? "";
    this.text = new Text("", 0, 0);
    this.updateDisplay();
  }

  getQuery(): string {
    return this.query;
  }

  setQuery(query: string): void {
    this.query = query;
    this.updateDisplay();
  }

  clear(): void {
    this.query = "";
    this.updateDisplay();
  }

  appendChar(char: string): void {
    this.query += char;
    this.updateDisplay();
  }

  backspace(): void {
    if (this.query.length > 0) {
      this.query = this.query.slice(0, -1);
      this.updateDisplay();
    }
  }

  private updateDisplay(): void {
    const theme = getTheme();
    const marker = this.focused ? CURSOR_MARKER : "";
    const queryDisplay = this.query
      ? theme.primary.bold(this.query)
      : theme.muted(this.placeholder);

    this.text.setText(theme.muted(this.prefix) + queryDisplay + marker);
  }

  invalidate(): void {
    this.text.invalidate();
  }

  render(width: number): string[] {
    return this.text.render(width);
  }
}
