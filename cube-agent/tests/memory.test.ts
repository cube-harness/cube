import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  RunnableConfigSchema,
  CubeHome,
  type CubeConfig,
  type Home,
} from "@cube/workspace";
import {
  createMemory,
  finalizeCubeAgentMemory,
} from "../src/memory.js";

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
    working_memory: {
      enabled: true,
      scope: "thread",
      use_state_signals: true,
      agent_managed: false,
      template: "# Thread Task State\n\n## Objective\n",
    },
    observational_memory: {
      enabled: true,
      scope: "thread",
      activate_after_idle: false,
      activate_on_provider_change: true,
      share_token_budget: false,
      temporal_markers: false,
      retrieval: { enabled: true, vector: false, scope: "thread" },
      observation: {
        model: "inherit",
        message_tokens: 30_000,
        buffer_tokens: 0.2,
        buffer_on_idle: false,
        buffer_activation: 0.8,
        block_after: 1.2,
        previous_observer_tokens: 2_000,
        instruction: null,
        manage_working_memory: true,
        thread_title: false,
        observe_attachments: "auto",
      },
      reflection: {
        model: "inherit",
        observation_tokens: 40_000,
        buffer_activation: 0.5,
        block_after: 1.2,
        instruction: null,
      },
    },
  },
  permissions: { require_approval_for: ["execute_command"] },
});

const createTestHome = async (): Promise<{ home: Home; root: string }> => {
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

test("maps the normalized task-memory pipeline without forwarding DEFAULT fields", async () => {
  const { home, root } = await createTestHome();
  try {
    const memory = createMemory(createConfig(), home);
    const merged = memory.getMergedThreadConfig();
    const om = merged.observationalMemory;

    assert.equal(memory.listTools().recall !== undefined, true);
    assert.equal(memory.listTools().setWorkingMemory, undefined);
    assert.equal(merged.workingMemory?.scope, "thread");
    assert.equal(merged.workingMemory?.agentManaged, false);
    assert.ok(om && typeof om === "object");
    assert.equal("model" in om, false);
    assert.equal(om.activateAfterIdle, false);
    assert.equal(om.activateOnProviderChange, true);
    assert.deepEqual(om.retrieval, { vector: false, scope: "thread" });
    assert.equal(om.observation?.manageWorkingMemory, true);
    assert.equal("modelSettings" in (om.observation ?? {}), false);
    assert.equal("providerOptions" in (om.observation ?? {}), false);
    assert.equal("maxTokensPerBatch" in (om.observation ?? {}), false);
    assert.equal("activateAfterIdle" in (om.observation ?? {}), false);
    assert.equal("activateOnProviderChange" in (om.observation ?? {}), false);
    assert.equal(om.observation?.extract?.length, 1);
    assert.equal(om.observation?.extract?.[0]?.slug, "working-memory");
    assert.equal("modelSettings" in (om.reflection ?? {}), false);
    assert.equal("providerOptions" in (om.reflection ?? {}), false);
    assert.equal("activateAfterIdle" in (om.reflection ?? {}), false);
    assert.equal("activateOnProviderChange" in (om.reflection ?? {}), false);
    assert.equal("extract" in (om.reflection ?? {}), false);
  } finally {
    await removeTestHome(root);
  }
});

test("resolves inherit against the model currently active on the Cube agent", async () => {
  const { home, root } = await createTestHome();
  try {
    const config = createConfig();
    config.memory.generate_title.enabled = true;
    const memory = createMemory(config, home);
    const merged = memory.getMergedThreadConfig();
    const om = merged.observationalMemory;
    assert.ok(om && typeof om === "object");
    assert.equal(typeof om.observation?.model, "function");
    assert.equal(typeof om.reflection?.model, "function");

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

    assert.equal(await (om.observation?.model as Function)(dynamicContext), activeModel);
    assert.equal(await (om.reflection?.model as Function)(dynamicContext), activeModel);

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

test("finalizes the installed observational-memory processor without exposing its record", async () => {
  const calls: unknown[] = [];
  const agent = {
    resolveProcessorById: async (id: string) => {
      assert.equal(id, "observational-memory");
      return {
        id,
        engine: {
          finalize: async (input: unknown) => {
            calls.push(input);
            return {
              activated: true,
              observed: false,
              reflected: false,
              record: { private: "mastra-internal" },
            };
          },
        },
      };
    },
  };

  assert.deepEqual(
    await finalizeCubeAgentMemory(agent, {
      threadId: "thread-1",
      resourceId: "workspace-1",
    }),
    {
      enabled: true,
      activated: true,
      observed: false,
      reflected: false,
    },
  );
  assert.deepEqual(calls, [
    { threadId: "thread-1", resourceId: "workspace-1" },
  ]);
});

test("reports observational memory as disabled when no finalizable processor exists", async () => {
  assert.deepEqual(
    await finalizeCubeAgentMemory(
      { resolveProcessorById: async () => null },
      { threadId: "thread-1", resourceId: "workspace-1" },
    ),
    {
      enabled: false,
      activated: false,
      observed: false,
      reflected: false,
    },
  );
});
