import type { CommandHandler, CommandManager } from "../command-manager.js";

export interface HelpCommandDependencies {
  commandManager: CommandManager;
  showMessage: (message: string) => void;
}

export const createHelpCommand = (
  deps: HelpCommandDependencies,
): CommandHandler => async () => {
  const suggestions = deps.commandManager.suggestions;

  if (!suggestions || suggestions.length === 0) {
    deps.showMessage("No slash commands available.");
    return;
  }

  const lines: string[] = [
    "### 📖 Available Slash Commands",
    "",
    "| Command | Description |",
    "| :--- | :--- |",
  ];

  for (const cmd of suggestions) {
    lines.push(`| \`${cmd.name}\` | ${cmd.description} |`);
  }

  lines.push("", "*Tip: Type `/` in the prompt editor to open auto-completion suggestions.*");

  deps.showMessage(lines.join("\n"));
};
