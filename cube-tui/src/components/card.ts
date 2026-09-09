import chalk from "chalk";
import { Box, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";

// Shared surface and spacing; children only render content.
export class Card extends Box implements Focusable {
  constructor(private readonly content: Component & Partial<Focusable>) {
    super(2, 1, (line) => {
      const background = chalk.bgHex(appTheme.surface.background);
      // Native inputs reset all SGR styles after the cursor, including the card's background.
      return line.split("\x1b[0m").map(part => background(part)).join("\x1b[0m");
    });
    this.addChild(content);
  }

  get focused(): boolean { return this.content.focused ?? false; }
  set focused(value: boolean) { this.content.focused = value; }
  handleInput(data: string): void { this.content.handleInput?.(data); }

  override render(width: number): string[] {
    return super.render(width).map((line) => truncateToWidth(line, width));
  }
}
