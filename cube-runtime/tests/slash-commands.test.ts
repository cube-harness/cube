import assert from "node:assert/strict";
import test from "node:test";
import {
  executeSlashCommand,
  parseSlashCommand,
  slashCommandSuggestions,
  type SlashCommandContext,
} from "../src/slash-commands.js";

const createContext = () => {
  const calls: unknown[][] = [];
  const state = {
    theme: "default",
    appTitle: ["model", "workspace"],
    statusLine: ["model", "threadId"],
  };
  const context = {
    thread: {
      list: async () => {
        calls.push(["thread.list"]);
        return [
          {
            id: "thread-2",
            title: "Two",
            updatedAt: "2026-08-28T00:00:00.000Z",
            isActive: false,
          },
        ];
      },
      resume: async (threadId: string) => {
        calls.push(["thread.resume", threadId]);
        return { threadId, title: "Two", messages: [] };
      },
      create: async () => {
        calls.push(["thread.create"]);
        return { threadId: null };
      },
      rename: async (title: string) => {
        calls.push(["thread.rename", title]);
        return { threadId: "thread-1", title };
      },
      delete: async (threadId: string) => {
        calls.push(["thread.delete", threadId]);
        return { threadId, wasActive: false };
      },
      fork: async (title?: string) => {
        calls.push(["thread.fork", title]);
        return { threadId: "thread-fork", title: title ?? "Fork", messages: [] };
      },
      lastAssistantContent: async () => {
        calls.push(["thread.lastAssistantContent"]);
        return "assistant markdown";
      },
    },
    model: {
      list: async () => {
        calls.push(["model.list"]);
        return { updatedAt: "1970-01-01T00:00:00.000Z", providers: {} };
      },
      current: () => {
        calls.push(["model.current"]);
        return { modelId: "google/gemini-3.7-flash" };
      },
      set: async (selection: unknown) => {
        calls.push(["model.set", selection]);
        return selection;
      },
      getUsage: async () => {
        calls.push(["model.getUsage"]);
        return {
          model: "google/gemini-3.7-flash",
          capabilities: ["tools"],
          contextLimit: 128_000,
          promptTokens: 1,
          completionTokens: 2,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 3,
          threadId: "thread-1",
        };
      },
    },
    preference: {
      get: () => {
        calls.push(["preference.get"]);
        return state;
      },
      setTheme: async (theme: string) => {
        calls.push(["preference.setTheme", theme]);
        return { ...state, theme };
      },
      setTitle: async (appTitle: string[]) => {
        calls.push(["preference.setTitle", appTitle]);
        return { ...state, appTitle };
      },
      setStatusLine: async (statusLine: string[]) => {
        calls.push(["preference.setStatusLine", statusLine]);
        return { ...state, statusLine };
      },
    },
    memory: {
      compact: async () => {
        calls.push(["memory.compact"]);
        return { activated: true, observed: true, reflected: false };
      },
    },
  } as unknown as SlashCommandContext;
  return { calls, context };
};

test("slash command parser preserves the command argument", () => {
  assert.deepEqual(parseSlashCommand("/model abc --effort high"), {
    name: "/model",
    argument: "abc --effort high",
  });
  assert.equal(parseSlashCommand("hello"), null);
  assert.equal(
    slashCommandSuggestions.some((item) => item.name === "/resume"),
    true,
  );
  assert.equal(
    slashCommandSuggestions.some((item) => item.name === "/threads"),
    true,
  );
});

test("slash command router delegates thread and model use cases", async () => {
  const { calls, context } = createContext();

  assert.deepEqual(await executeSlashCommand("/resume", "", context), {
    kind: "threads",
    operation: "resume",
    threads: [
      {
        id: "thread-2",
        title: "Two",
        updatedAt: "2026-08-28T00:00:00.000Z",
        isActive: false,
      },
    ],
  });
  assert.equal(
    (await executeSlashCommand("/resume", "thread-2", context)).kind,
    "thread",
  );
  assert.deepEqual(await executeSlashCommand("/new", "", context), {
    kind: "thread-reset",
  });
  assert.deepEqual(await executeSlashCommand("/delete", "", context), {
    kind: "threads",
    operation: "delete",
    threads: [
      {
        id: "thread-2",
        title: "Two",
        updatedAt: "2026-08-28T00:00:00.000Z",
        isActive: false,
      },
    ],
  });
  assert.equal(
    (await executeSlashCommand("/delete", "thread-2", context)).kind,
    "notice",
  );
  assert.equal((await executeSlashCommand("/model", "", context)).kind, "models");
  assert.deepEqual(
    await executeSlashCommand(
      "/model",
      "openrouter/poolside/laguna-xs-2.1:free --effort high",
      context,
    ),
    {
      kind: "model",
      model: {
        modelId: "openrouter/poolside/laguna-xs-2.1:free",
        reasoningEffort: "high",
      },
    },
  );
  assert.equal((await executeSlashCommand("/usage", "", context)).kind, "usage");

  assert.deepEqual(calls, [
    ["thread.list"],
    ["thread.resume", "thread-2"],
    ["thread.create"],
    ["thread.list"],
    ["thread.delete", "thread-2"],
    ["model.list"],
    ["model.current"],
    [
      "model.set",
      {
        modelId: "openrouter/poolside/laguna-xs-2.1:free",
        reasoningEffort: "high",
      },
    ],
    ["model.getUsage"],
  ]);
});

test("slash command router returns domain results for client-owned effects", async () => {
  const { calls, context } = createContext();

  assert.equal((await executeSlashCommand("/compact", "", context)).kind, "notice");
  assert.equal(
    (await executeSlashCommand("/rename", "Renamed", context)).kind,
    "notice",
  );
  assert.equal(
    (await executeSlashCommand("/fork", "Branch", context)).kind,
    "thread",
  );
  assert.deepEqual(await executeSlashCommand("/copy", "", context), {
    kind: "copy-content",
    content: "assistant markdown",
  });
  assert.deepEqual(await executeSlashCommand("/theme", "", context), {
    kind: "preferences",
    request: { target: "theme", current: "default" },
  });
  assert.equal(
    (await executeSlashCommand("/theme", "dracula", context)).kind,
    "preference",
  );
  assert.deepEqual(await executeSlashCommand("/title", "", context), {
    kind: "preferences",
    request: { target: "title", current: ["model", "workspace"] },
  });
  assert.deepEqual(await executeSlashCommand("/statusline", "", context), {
    kind: "preferences",
    request: { target: "statusLine", current: ["model", "threadId"] },
  });
  assert.equal(
    (await executeSlashCommand("/title", "model, threadId", context)).kind,
    "preference",
  );
  assert.equal(
    (await executeSlashCommand("/statusline", "workspace, agentMd", context)).kind,
    "preference",
  );
  assert.equal((await executeSlashCommand("/help", "", context)).kind, "command-catalog");
  assert.deepEqual(await executeSlashCommand("/exit", "", context), {
    kind: "exit-requested",
  });
  assert.deepEqual(calls, [
    ["memory.compact"],
    ["thread.rename", "Renamed"],
    ["thread.fork", "Branch"],
    ["thread.lastAssistantContent"],
    ["preference.get"],
    ["preference.setTheme", "dracula"],
    ["preference.get"],
    ["preference.get"],
    ["preference.setTitle", ["model", "threadId"]],
    ["preference.setStatusLine", ["workspace", "agentMd"]],
  ]);
});

test("slash command router converts an unknown command into one error result", async () => {
  const { calls, context } = createContext();
  assert.deepEqual(await executeSlashCommand("/missing", "", context), {
    kind: "notice",
    notice: { level: "error", message: "Unknown command: /missing" },
  });
  assert.deepEqual(calls, []);
});
