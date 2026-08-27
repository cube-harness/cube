import {
  CURSOR_MARKER,
  Input,
  truncateToWidth,
  visibleWidth,
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
  private readonly input = new Input();
  private readonly placeholder: string;
  private readonly prefix: string;

  constructor(options: SearchBarOptions = {}) {
    this.placeholder = options.placeholder ?? "Type to filter...";
    this.prefix = options.prefix ?? "Search: ";
    this.input.setValue(options.initialQuery ?? "");
    this.input.focused = true;
  }

  getQuery(): string {
    return this.input.getValue();
  }

  setQuery(query: string): void {
    this.input.setValue(query);
  }

  clear(): void {
    this.input.setValue("");
  }

  appendChar(char: string): void {
    this.input.handleInput(char);
  }

  backspace(): void {
    const query = this.input.getValue();
    if (query.length > 0) {
      this.input.setValue(query.slice(0, -1));
    }
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  invalidate(): void {
    // No cached state
  }

  render(width: number): string[] {
    const theme = getTheme();
    const query = this.input.getValue();

    if (query.length === 0) {
      const marker = this.focused ? CURSOR_MARKER : "";
      const cursorChar = this.focused ? "\x1b[7m \x1b[27m" : "";
      const line = `${theme.muted(this.prefix)}${theme.muted(this.placeholder)}${marker}${cursorChar}`;
      return [truncateToWidth(line, width)];
    }

    const prefixWidth = visibleWidth(this.prefix);
    const availWidth = Math.max(5, width - prefixWidth + 2);
    const inputLines = this.input.render(availWidth);
    let inputContent = inputLines[0] ?? "";
    if (inputContent.startsWith("> ")) {
      inputContent = inputContent.slice(2);
    }

    const line = `${theme.muted(this.prefix)}${theme.primary.bold(inputContent)}`;
    return [truncateToWidth(line, width)];
  }
}
