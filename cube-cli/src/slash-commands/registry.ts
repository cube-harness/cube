import type { SlashCommandSuggestion } from "@cube/tui";
import {
  createCompactCommandHandler,
  type CompactCommandDependencies,
} from "./compact.slash-command.js";
import {
  createExitCommandHandler,
  type ExitCommandDependencies,
} from "./exit.slash-command.js";
import {
  createModelCommandHandler,
  type ModelCommandDependencies,
} from "./model.slash-command.js";

export type SlashCommandHandler = (argument: string) => Promise<void>;

export interface SlashCommandDefinition {
  name: `/${string}`;
  description: string;
  handler: SlashCommandHandler;
}

export interface SlashCommandRegistryInput {
  compact: CompactCommandDependencies;
  exit: ExitCommandDependencies;
  model: ModelCommandDependencies;
  showMessage: (message: string) => void;
}

export const createSlashCommandRegistry = (
  input: SlashCommandRegistryInput,
) => {
  const definitions: SlashCommandDefinition[] = [
    {
      name: "/compact",
      description: "Finalize pending observational memory",
      handler: createCompactCommandHandler(input.compact),
    },
    {
      name: "/exit",
      description: "Exit Cube",
      handler: createExitCommandHandler(input.exit),
    },
    {
      name: "/model",
      description: "List or switch the active model",
      handler: createModelCommandHandler(input.model),
    },
  ];
  const byName = new Map(definitions.map((definition) => [
    definition.name,
    definition.handler,
  ]));

  const execute = async (name: `/${string}`, argument: string): Promise<void> => {
    const handler = byName.get(name);
    if (!handler) {
      input.showMessage(`Unknown command: ${name}`);
      return;
    }
    await handler(argument);
  };

  const suggestions: SlashCommandSuggestion[] = definitions.map(
    ({ name, description }) => ({ name, description }),
  );

  return { execute, suggestions };
};
