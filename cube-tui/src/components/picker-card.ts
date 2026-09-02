import chalk from "chalk";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";

export const renderPickerCard = (
  contentLines: string[],
  width: number,
): string[] => {
  const innerWidth = Math.max(1, width - 4);
  const background = chalk.bgHex(appTheme.surface.background);
  const rendered = [""];

  for (const rawLine of contentLines) {
    const line = truncateToWidth(rawLine, innerWidth);
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
    rendered.push(`  ${background(` ${line}${padding} `)}`);
  }

  rendered.push("");
  return rendered;
};
