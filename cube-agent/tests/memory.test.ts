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
