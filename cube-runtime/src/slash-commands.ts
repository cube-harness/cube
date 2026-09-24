import type { ReasoningEffort } from "@cube/workspace";
import type { MemoryService } from "./services/memory.service.js";
import type { ModelService } from "./services/model.service.js";
import type { PreferenceService } from "./services/preference.service.js";
import type { ThreadService } from "./services/thread.service.js";
import type { GatewayService } from "./services/gateway.service.js";
import { toRuntimeNotice, type PromptResult, type SlashCommandSuggestion } from "./types.js";

export type ParsedSlashCommand = {
  name: `/${string}`;
  argument: string;
};

export type SlashCommandContext = {
  thread: ThreadService;
  model: ModelService;
  preference: PreferenceService;
  memory: MemoryService;
  gateway: GatewayService;
};

type SlashCommandDefinition = SlashCommandSuggestion & {
  aliases?: `/${string}`[];
  execute(argument: string, context: SlashCommandContext): Promise<PromptResult>;
};

const reasoningEfforts = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "default",
]);

const parseFields = (argument: string): string[] =>
  argument
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);

const parseModelSelection = (argument: string) => {
  const tokens = argument.trim().split(/\s+/).filter(Boolean);
  const modelId = tokens.shift();
  if (!modelId) throw new Error("Usage: /model <model-id> [--effort <level>]");
  if (tokens.length === 0) return { modelId };
  if (tokens.length !== 2 || tokens[0] !== "--effort") {
    throw new Error("Usage: /model <model-id> [--effort <level>]");
  }
  const reasoningEffort = tokens[1] as ReasoningEffort;
  if (!reasoningEfforts.has(reasoningEffort)) {
    throw new Error(`Unsupported reasoning effort: ${tokens[1]}`);
  }
  return { modelId, reasoningEffort };
};

const definitions: SlashCommandDefinition[] = [
  {
    name: "/reload",
    description: "Reload SOUL and known project instructions",
    execute: async (_argument, context) => {
      await context.thread.reload();
      return { kind: "notice", notice: { level: "info", message: "Project context reloaded." } };
    },
  },
  {
    name: "/resume",
    aliases: ["/threads"],
    description: "Switch to a previous conversation",
    execute: async (argument, context) => {
      if (argument) {
        return {
          kind: "thread",
          snapshot: await context.thread.resume(argument),
        };
      }
      return {
        kind: "threads",
        operation: "resume",
        threads: await context.thread.list(),
      };
    },
  },
  {
    name: "/new",
    description: "Start a new conversation",
    execute: async (_argument, context) => {
      await context.thread.create();
      return { kind: "thread-reset" };
    },
  },
  {
    name: "/exit",
    description: "Exit Cube",
    execute: async () => ({ kind: "exit-requested" }),
  },
  {
    name: "/compact",
    description: "Finalize pending observational memory",
    execute: async (_argument, context) => {
      const result = await context.memory.compact();
      return {
        kind: "notice",
        notice: {
          level: "info",
          message: result.activated
            ? "Memory compacted."
            : "No pending observational memory required compaction.",
        },
      };
    },
  },
  {
    name: "/gateway",
    description: "Choose or configure an API, oauth, or local gateway",
    execute: async (_argument, context) => {
      const [choices, readiness] = await Promise.all([
        context.gateway.listChoices(),
        context.gateway.readiness(),
      ]);
      return {
        kind: "gateways",
        request: {
          choices,
          ...(readiness.ready
            ? {
                current: {
                  gatewayId: readiness.gatewayId,
                  model: readiness.model,
                },
              }
            : {}),
        },
      };
    },
  },
  {
    name: "/model",
    description: "Choose what model and reasoning effort to use",
    execute: async (argument, context) => {
      if (!argument) {
        const catalog = await context.model.list();
        if (Object.values(catalog.providers).every((provider) => provider.models.length === 0)) {
          return {
            kind: "notice",
            notice: {
              level: "info",
              message:
                "No models are available for this gateway. Run /gateway to choose another gateway.",
            },
          };
        }
        const readiness = await context.gateway.readiness();
        if (!readiness.ready) {
          return {
            kind: "notice",
            notice: { level: "error", message: readiness.reason },
          };
        }
        return {
          kind: "models",
          gatewayId: readiness.gatewayId,
          catalog,
          current: context.model.current(),
        };
      }
      return {
        kind: "model",
        model: await context.model.set(parseModelSelection(argument)),
      };
    },
  },
  {
    name: "/effort",
    aliases: ["/thinking"],
    description: "Set reasoning effort for the active model",
    execute: async (argument, context) => {
      const current = context.model.current();
      if (!current.modelId) {
        return {
          kind: "notice",
          notice: { level: "error", message: "No active model is configured." },
        };
      }

      const input = argument.trim().toLowerCase();

      if (!input) {
        const catalog = await context.model.list();
        const readiness = await context.gateway.readiness();
        if (!readiness.ready) {
          return { kind: "notice", notice: { level: "error", message: readiness.reason } };
        }

        const currentModel = Object.values(catalog.providers)
          .flatMap((p) => p.models)
          .find((m) => m.modelId === current.modelId);

        if (!currentModel?.reasoning_efforts?.length) {
          return {
            kind: "notice",
            notice: {
              level: "error",
              message: `Model ${current.modelId} does not support reasoning effort.`,
            },
          };
        }

        return {
          kind: "models",
          gatewayId: readiness.gatewayId,
          catalog,
          current,
          step: "reasoning",
        };
      }

      const effort = input as ReasoningEffort;
      if (!reasoningEfforts.has(effort)) {
        return {
          kind: "notice",
          notice: {
            level: "error",
            message: `Unsupported reasoning effort: "${input}". Valid values: ${Array.from(reasoningEfforts).join(", ")}`,
          },
        };
      }

      return {
        kind: "model",
        model: await context.model.set({ modelId: current.modelId, reasoningEffort: effort }),
      };
    },
  },
  {
    name: "/help",
    description: "Show available commands",
    execute: async () => ({
      kind: "command-catalog",
      commands: slashCommandSuggestions,
    }),
  },
  {
    name: "/rename",
    description: "Rename current conversation /rename <title>",
    execute: async (argument, context) => {
      const result = await context.thread.rename(argument);
      return {
        kind: "notice",
        notice: { level: "info", message: `Renamed thread to: ${result.title}` },
      };
    },
  },
  {
    name: "/delete",
    description: "Delete a conversation",
    execute: async (argument, context) => {
      if (!argument) {
        return {
          kind: "threads",
          operation: "delete",
          threads: await context.thread.list(),
        };
      }
      const result = await context.thread.delete(argument);
      if (result.wasActive) return { kind: "thread-reset" };
      return {
        kind: "notice",
        notice: { level: "info", message: `Deleted thread: ${result.threadId}` },
      };
    },
  },
  {
    name: "/fork",
    description: "Fork current conversation into a new branch",
    execute: async (argument, context) => ({
      kind: "thread",
      snapshot: await context.thread.fork(argument || undefined),
    }),
  },
  {
    name: "/status",
    aliases: ["/usage"],
    description: "Show session status, context usage and subscription limits",
    execute: async (_argument, context) => {
      const metrics = await context.model.getUsage();
      try {
        const subscription = await context.gateway.getSubscriptionUsage();
        return { kind: "usage", metrics: subscription ? { ...metrics, subscription } : metrics,
          ...(subscription?.notice ? { notice: toRuntimeNotice(new Error(subscription.notice)) } : {}),
        };
      } catch (error) {
        return { kind: "usage", metrics, notice: toRuntimeNotice(error) };
      }
    },
  },
  {
    name: "/theme",
    description: "Choose a syntax highlighting theme /theme [name]",
    execute: async (argument, context) => {
      if (argument) {
        return {
          kind: "preference",
          preference: await context.preference.setTheme(argument.toLowerCase()),
        };
      }
      return {
        kind: "preferences",
        request: { target: "theme", current: context.preference.get().theme },
      };
    },
  },
  {
    name: "/copy",
    description: "Copy last response as markdown",
    execute: async (_argument, context) => {
      const content = await context.thread.lastAssistantContent();
      if (!content) {
        return {
          kind: "notice",
          notice: { level: "info", message: "No assistant response found to copy." },
        };
      }
      return { kind: "copy-content", content };
    },
  },
  {
    name: "/title",
    description: "Configure which items appear in the terminal title",
    execute: async (argument, context) => {
      const fields = parseFields(argument);
      if (fields.length > 0) {
        return {
          kind: "preference",
          preference: await context.preference.setTitle(fields),
        };
      }
      return {
        kind: "preferences",
        request: { target: "title", current: context.preference.get().appTitle },
      };
    },
  },
  {
    name: "/statusline",
    description: "Configure which items appear in the status line",
    execute: async (argument, context) => {
      const fields = parseFields(argument);
      if (fields.length > 0) {
        return {
          kind: "preference",
          preference: await context.preference.setStatusLine(fields),
        };
      }
      return {
        kind: "preferences",
        request: {
          target: "statusLine",
          current: context.preference.get().statusLine,
        },
      };
    },
  },
];

const commandByName = new Map<`/${string}`, SlashCommandDefinition>();
for (const definition of definitions) {
  commandByName.set(definition.name, definition);
  for (const alias of definition.aliases ?? []) commandByName.set(alias, definition);
}

export const slashCommandSuggestions: SlashCommandSuggestion[] = definitions.flatMap(
  ({ name, description, aliases = [] }) => [
    { name, description },
    ...aliases.map((alias) => ({
      name: alias,
      description: `Alias for ${name}`,
    })),
  ],
);

export const parseSlashCommand = (content: string): ParsedSlashCommand | null => {
  if (!content.startsWith("/")) return null;
  const separator = content.search(/\s/);
  if (separator === -1) {
    return { name: content as `/${string}`, argument: "" };
  }
  return {
    name: content.slice(0, separator) as `/${string}`,
    argument: content.slice(separator).trim(),
  };
};

export const executeSlashCommand = async (
  name: `/${string}`,
  argument: string,
  context: SlashCommandContext,
): Promise<PromptResult> => {
  const definition = commandByName.get(name);
  if (!definition) {
    return {
      kind: "notice",
      notice: { level: "error", message: `Unknown command: ${name}` },
    };
  }

  try {
    return await definition.execute(argument.trim(), context);
  } catch (error: unknown) {
    return {
      kind: "notice",
      notice: toRuntimeNotice(error),
    };
  }
};
