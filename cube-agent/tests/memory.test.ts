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
import { createMemory } from "../src/memory.js";

const createConfig = (): CubeConfig => RunnableConfigSchema.parse({
  gateway: "api_key/google",
  model: "google/gemini-3.7-flash",
  model_config: { reasoning_effort: "high" },
  gateway_options: {},
  theme: "dark",
  telemetry: false,
  soul: { max_characters: 20_000 },
  memory: {
    storage: { provider: "sqlite", mode: "local" },
    vector: { enabled: false, provider: "sqlite", mode: "local" },
    embedder: { enabled: false, model: null },
    generate_title: {
      enabled: false,
      model: "inherit",
      instructions: "Generate a concise title under 80 characters.",
    },
    semantic_recall: {
      enabled: false,
      top_k: 4,
      message_range: { before: 1, after: 1 },
      scope: "resource",
      threshold: null,
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
          return { getModel: async () => activeModel };
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

test("uses Cube's local memory database for optional vector storage", async () => {
  const { home, root } = await createTestHome();
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  let memory: any;
  try {
    process.env.OPENAI_API_KEY = "cube-memory-test-key";
    const config = createConfig();
    config.memory.vector.enabled = true;
    config.memory.embedder.enabled = true;
    config.memory.embedder.model = "openai/text-embedding-3-small";
    config.memory.semantic_recall.enabled = true;

    memory = createMemory(config, home) as any;

    assert.equal(memory.vector?.id, "cube-vector");
    assert.equal(memory.vector?.constructor?.name, "LibSQLVector");
    assert.equal(memory.embedder?.provider, "openai");
    assert.equal(memory.embedder?.modelId, "text-embedding-3-small");
    assert.equal(home.getMemoryDbPath(), path.join(root, "memories", "memory.sqlite"));
  } finally {
    await memory?.vector?.close();
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    await removeTestHome(root);
  }
});
