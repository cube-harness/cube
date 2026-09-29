import { Markdown as PiMarkdown, stripTerminalSequences } from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";
import { createMarkdownTheme } from "../themes/pi-tui.theme.js";

// Zero-width marker: identify native fence rows without matching actual code text.
const fenceRow = "\u001b]777;cube-code-fence\u0007";

export class Markdown extends PiMarkdown {
  constructor(text: string) {
    super(
      text,
      0,
      0,
      { ...createMarkdownTheme(), codeBlockBorder: () => fenceRow },
      { color: appTheme.role.assistant },
    );
  }

  override render(width: number): string[] {
    const lines: string[] = [];
    let inCode = false;
    for (const line of super.render(width)) {
      if (!line.includes(fenceRow)) {
        lines.push(line);
        continue;
      }
      // Native Markdown adds paragraph spacing before the opening fence too.
      if (!inCode && lines.length && !stripTerminalSequences(lines.at(-1)!).trim()) {
        lines.pop();
      }
      inCode = !inCode;
      const remainder = line.replace(fenceRow, "");
      // Keep structural prefixes (e.g. list bullets) on nested code blocks.
      if (stripTerminalSequences(remainder).trim()) lines.push(remainder);
    }
    return lines;
  }
}
