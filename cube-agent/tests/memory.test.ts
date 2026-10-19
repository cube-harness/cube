import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  RunnableConfigSchema,
  CubeHome,
  type CubeConfig,
  type HomeManager,
} from "@cube/workspace";
import { createMemory, resolveMemoryModel } from "../src/memory.js";
import { Agent } from "@mastra/core/agent";
import { MockLanguageModelV3 } from "ai/test";

const createConfig = (): CubeConfig => RunnableConfigSchema.parse({
  gateway: "api_key/google",
  model: "google/gemini-3.7-flash",
  model_config: { reasoning_effort: "high" },
  gateway_options: {},
  theme: "dark",
  telemetry: false,
  soul: { max_characters: 20_000 },
  memory: {
    generate_title: {
      enabled: false,
      model: "inherit",
      instructions: "Generate a concise title under 80 characters.",
    },
    compaction: { manual_min_ratio: 0.3, keep_recent_ratio: 0.25, reserve_tokens: 16384 },
  },
  permissions: { require_approval_for: ["execute_command"] },
});

const createTestHome = async (): Promise<{ home: HomeManager; root: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-memory-test-"));
  const home = CubeHome({ cubeHome: root });
  await home.ensure();
  return { home, root };
};

const removeTestHome = (root: string) =>
  rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

test("keeps code-owned Memory options fixed outside public YAML", async () => {
  const { home, root } = await createTestHome();
  try {
    const memory = createMemory(createConfig(), home);
    const merged = memory.getMergedThreadConfig();

    assert.equal(merged.readOnly, false);
    assert.equal(merged.lastMessages, Number.MAX_SAFE_INTEGER);
    assert.equal(merged.filterIncompleteToolCalls, true);
    assert.equal(merged.generateTitle, false);
  } finally {
    await removeTestHome(root);
  }
});

test("disables OM and Working Memory tools and state injection", async () => {
  const { home, root } = await createTestHome();
  try {
    const memory = createMemory(createConfig(), home);
    const merged = memory.getMergedThreadConfig();
    assert.equal(merged.observationalMemory, false);
    assert.equal(memory.listTools().recall, undefined);
    assert.equal(memory.listTools().setWorkingMemory, undefined);
    assert.equal(merged.workingMemory?.enabled, false);
    assert.equal(memory.listTools().updateWorkingMemory, undefined);
    assert.equal(await memory.createWorkingMemoryStateProcessor(), null);
  } finally { await removeTestHome(root); }
});

test("resolves inherit against the model currently active on the Cube agent", async () => {
  const { home, root } = await createTestHome();
  try {
    const config = createConfig();
    config.memory.generate_title.enabled = true;
    const memory = createMemory(config, home);
    const merged = memory.getMergedThreadConfig();
    const activeModel = "openrouter/poolside/laguna-xs-2.1:free";
    const dynamicContext = {
      requestContext: {},
      mastra: {
        getAgentById: (id: string) => {
          assert.equal(id, "cube-agent");
          return { getModel: async () => activeModel, getModelList: async () => null, getActiveModelId: () => activeModel };
        },
      },
    } as any;


    const generateTitle = merged.generateTitle;
    assert.ok(generateTitle && typeof generateTitle === "object");
    assert.equal(typeof generateTitle.model, "function");
    assert.equal(await (generateTitle.model as Function)(dynamicContext), activeModel);
  } finally {
    await removeTestHome(root);
  }
});

test("auxiliary effort reaches provider calls without changing the parent's settings", async () => {
  let received: unknown;
  const model = new MockLanguageModelV3({ doStream: async options => {
    received = options.providerOptions;
    return { stream: new ReadableStream({ start(controller) { controller.close(); } }) };
  } });
  const parent = new Agent({ id: "effort-parent", name: "parent", instructions: "test",
    model: [{ model, providerOptions: { google: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } } } }] });
  const run = async (selection: { model: string; reasoning_effort?: "low" | "default" }) => {
    const resolved = await resolveMemoryModel(parent, "google/gemini-3.7-flash", selection);
    await resolved.doStream({ prompt: [] } as any);
    return received;
  };
  assert.deepEqual(await run({ model: "inherit" }), { google: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } } });
  assert.deepEqual(await run({ model: "inherit", reasoning_effort: "low" }), { google: { thinkingConfig: { thinkingLevel: "low", includeThoughts: true } } });
  assert.equal(await run({ model: "inherit", reasoning_effort: "default" }), undefined);
  assert.deepEqual((await parent.getModelList())?.[0].providerOptions, { google: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } } });
});

test("native title generation resolves its own model and effort through Cube gateways", async () => {
  const { home, root } = await createTestHome();
  try {
    const config = createConfig();
    config.memory.generate_title = { ...config.memory.generate_title, enabled: true, model: "google/gemini-3.8-flash", reasoning_effort: "low" };
    let received: unknown, selected: unknown;
    const model = new MockLanguageModelV3({ doGenerate: async options => {
      received = options.providerOptions;
      return { content: [{ type: "text", text: "Cube title" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [] };
    } });
    const parent = new Agent({ id: "title-parent", name: "parent", instructions: "test", model });
    const generateTitle = createMemory(config, home).getMergedThreadConfig().generateTitle;
    assert.ok(generateTitle && typeof generateTitle === "object");
    const resolved = await (generateTitle.model as Function)({ requestContext: {}, mastra: {
      getAgentById: () => ({ getActiveModelId: () => "cube-api/google/gemini-3.7-flash",
        getModelList: parent.getModelList.bind(parent),
        getModel: async (options: unknown) => { selected = options; return model; } }),
    } });
    assert.equal(await parent.generateTitleFromUserMessage({ message: "First prompt", model: resolved }), "Cube title");
    assert.ok(JSON.stringify(selected).includes("cube-api/google/gemini-3.8-flash"));
    assert.deepEqual(received, { google: { thinkingConfig: { thinkingLevel: "low", includeThoughts: true } } });
  } finally { await removeTestHome(root); }
});

test("durable retrieval does not enable embedding or semantic recall over raw history", async () => {
  const { home, root } = await createTestHome();
  let memory: any;
  try {
    const config = createConfig();
    config.memory.durable.retrieval.enabled = true;
    config.memory.durable.retrieval.model = "openai/text-embedding-3-small";

    memory = createMemory(config, home) as any;

    assert.equal(memory.vector, undefined);
    assert.equal(memory.embedder, undefined);
    assert.equal(memory.getMergedThreadConfig().semanticRecall, false);
    assert.equal(home.getMemoryDbPath(), path.join(root, "memories", "memory.sqlite"));
  } finally {
    await removeTestHome(root);
  }
});
