import type { SlashCommandSuggestion } from "./contracts/events.contract.js";

export type CommandHandler = (argument: string) => Promise<void>;

export interface CommandDefinition {
  name: string;
  description: string;
  handler: CommandHandler;
}

export class CommandManager {
  private readonly commands = new Map<string, CommandDefinition>();

  constructor(private readonly showMessage: (message: string) => void) {}

  register(definition: CommandDefinition): this {
    this.commands.set(definition.name, definition);
    return this;
  }

  registerMany(definitions: CommandDefinition[]): this {
    for (const def of definitions) {
      this.register(def);
    }
    return this;
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  async execute(name: string, argument: string = ""): Promise<void> {
    const command = this.commands.get(name);
    if (!command) {
      this.showMessage(`Unknown command: ${name}`);
      return;
    }
    await command.handler(argument);
  }

  get suggestions(): SlashCommandSuggestion[] {
    return Array.from(this.commands.values()).map(({ name, description }) => ({
      name: (name.startsWith("/") ? name : `/${name}`) as `/${string}`,
      description,
    }));
  }
}
