import assert from "node:assert/strict";
import test from "node:test";
import {
  executeSlashCommand,
  parseSlashCommand,
  slashCommandSuggestions,
  type SlashCommandContext,
} from "../src/slash-commands.js";

const catalog = {
  updatedAt: "2026-09-05T00:00:00.000Z",
  providers: {
    google: {
      name: "Google",
      models: [{
        modelId: "google/gemini-3.7-flash",
        name: "Gemini 3.7 Flash",
        reasoning: true,
        tool_call: true,
        structured_output: true,
        attachment: true,
        open_weights: false,
        limit: { context: 128_000, output: 8_192 },
        modalities: { input: ["text"], output: ["text"] },
      }],
    },
  },
};

test("/skills only lists preferences without a gateway or thread", async () => {
  const result = await executeSlashCommand("/skills", "", {
    preference: { listSkills: async () => [] },
  } as unknown as SlashCommandContext);
  assert.deepEqual(result, { kind: "skills", skills: [] });
});

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
        return catalog;
      },
      current: () => {
        calls.push(["model.current"]);
        return { modelId: "google/gemini-3.7-flash" };
      },
      set: async (selection: unknown) => {
        calls.push(["model.set", selection]);
        if (!(selection as { modelId: string }).modelId.startsWith("google/")) {
          throw new Error("Model is not available through api_key/google.");
        }
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
        return { status: "compacted", before: 90000, after: 10000 };
      },
    },
    gateway: {
      getSubscriptionUsage: async () => {
        calls.push(["gateway.getSubscriptionUsage"]);
        return undefined;
      },
      readiness: async () => {
        calls.push(["gateway.readiness"]);
        return {
          ready: true,
          gatewayId: "api_key/google",
          model: { modelId: "google/gemini-3.7-flash" },
        };
      },
      listChoices: async () => {
        calls.push(["gateway.listChoices"]);
        return [{
          gatewayId: "api_key/google",
          group: "api_key",
          provider: "google",
          configured: true,
        }];
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
  assert.equal(slashCommandSuggestions.some((item) => item.name === "/gateway"), true);
  assert.equal(slashCommandSuggestions.some((item) => item.name === "/login"), false);
  assert.equal(slashCommandSuggestions.some((item) => item.name === "/logout"), false);
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
  assert.deepEqual(await executeSlashCommand("/model", "", context), {
    kind: "models",
    gatewayId: "api_key/google",
    catalog,
    current: { modelId: "google/gemini-3.7-flash" },
  });
  assert.deepEqual(
    await executeSlashCommand(
      "/model",
      "google/gemini-3.7-flash --effort high",
      context,
    ),
    {
      kind: "model",
      model: {
        modelId: "google/gemini-3.7-flash",
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
    ["gateway.readiness"],
    ["model.current"],
    [
      "model.set",
      {
        modelId: "google/gemini-3.7-flash",
        reasoningEffort: "high",
      },
    ],
    ["model.getUsage"],
    ["gateway.getSubscriptionUsage"],
  ]);
});

test("status and usage include subscription limits and preserve session status on quota errors", async () => {
  const { context } = createContext();
  const subscription = { provider: "OpenAI", plan: "pro", limits: [] };
  context.gateway.getSubscriptionUsage = async () => subscription;
  for (const command of ["/status", "/usage"] as const) {
    const result = await executeSlashCommand(command, "", context);
    assert.equal(result.kind, "usage");
    if (result.kind !== "usage") assert.fail("Expected usage");
    assert.deepEqual(result.metrics.subscription, subscription);
    assert.equal(result.metrics.promptTokens, 1);
  }
  context.gateway.getSubscriptionUsage = async () => ({ ...subscription, notice: "Anthropic profile (HTTP 403): unavailable" });
  const partial = await executeSlashCommand("/status", "", context);
  assert.equal(partial.kind, "usage");
  if (partial.kind !== "usage") assert.fail("Expected usage");
  assert.equal(partial.metrics.subscription?.plan, "pro");
  assert.match(partial.notice?.message ?? "", /Anthropic profile.*403/);
  context.gateway.getSubscriptionUsage = async () => { throw new Error("OpenAI usage (HTTP 429): retry later"); };
  const result = await executeSlashCommand("/status", "", context);
  assert.equal(result.kind, "usage");
  if (result.kind !== "usage") assert.fail("Expected usage");
  assert.equal(result.metrics.promptTokens, 1);
  assert.equal(result.metrics.subscription, undefined);
  assert.deepEqual(result.notice, { level: "error", message: "OpenAI usage (HTTP 429): retry later" });
});

test("model command cannot select a model from another gateway", async () => {
  const { context } = createContext();

  assert.deepEqual(await executeSlashCommand("/model", "openrouter/other", context), {
    kind: "notice",
    notice: {
      level: "error",
      message: "Model is not available through api_key/google.",
    },
  });
});

test("gateway command returns serializable choices and current selection", async () => {
  const { calls, context } = createContext();
  const result = await executeSlashCommand("/gateway", "", context);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    kind: "gateways",
    request: {
      choices: [{
        gatewayId: "api_key/google",
        group: "api_key",
        provider: "google",
        configured: true,
      }],
      current: {
        gatewayId: "api_key/google",
        model: { modelId: "google/gemini-3.7-flash" },
      },
    },
  });
  assert.deepEqual(calls, [["gateway.listChoices"], ["gateway.readiness"]]);
});

test("model command directs an empty active gateway to gateway selection", async () => {
  const { context } = createContext();
  context.model.list = async () => ({ ...catalog, providers: {} });

  assert.deepEqual(await executeSlashCommand("/model", "", context), {
    kind: "notice",
    notice: {
      level: "info",
      message: "No models are available for this gateway. Run /gateway to choose another gateway.",
    },
  });
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
