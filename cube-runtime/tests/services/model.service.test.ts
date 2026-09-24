import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Session } from "@cube/agent";
import {
  ConfigStore,
  createBootstrap,
  HomeManager,
  type ModelCatalog,
} from "@cube/workspace";
import { ModelService } from "../../src/services/model.service.js";
import type { ModelSelection } from "../../src/types.js";

const reasoningModelId = "openrouter/poolside/laguna-xs-2.1:free";

const catalog: ModelCatalog = {
  updatedAt: new Date(0).toISOString(),
  providers: {
    openrouter: {
      name: "OpenRouter",
      models: [
        {
          modelId: reasoningModelId,
          name: "Laguna",
          reasoning: true,
          reasoning_efforts: ["none", "high"],
          tool_call: true,
          structured_output: false,
          attachment: false,
          open_weights: false,
          limit: { context: 128_000, output: 8_192 },
          modalities: { input: ["text"], output: ["text"] },
        },
        {
          modelId: "openrouter/example/plain",
          name: "Plain",
          reasoning: false,
          tool_call: true,
          structured_output: false,
          attachment: false,
          open_weights: false,
          limit: { context: 32_000, output: 4_096 },
          modalities: { input: ["text"], output: ["text"] },
        },
      ],
    },
  },
};

const createSession = (): Session =>
  ({
    identity: {
      getId: () => "session-test-id",
      getResourceId: () => "/workspace/cube",
    },
    thread: {
      getId: () => "thread-usage-123",
      list: async () => [
        { id: "thread-usage-123", title: "Runtime Refactor" },
      ],
    },
    getTokenUsage: () => ({
      promptTokens: 1_107_982,
      completionTokens: 20_730,
      reasoningTokens: 10_231,
      totalTokens: 1_128_712,
      cachedInputTokens: 728_514,
      cacheCreationInputTokens: 1_024,
      raw: { inputTokens: { total: 18_825, cacheRead: 8_640, cacheWrite: 128 } },
    }),
  }) as unknown as Session;

test("ModelService delegates catalog reads, persists a valid selection, and applies it live", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cube-model-service-"));
  const home = new HomeManager({ cubeHome: directory });
  await createBootstrap(home).run();
  const listed: string[] = [];
  const applied: ModelSelection[] = [];
  const service = new ModelService(
    home,
    createSession(),
    { modelId: "google/gemini-3.7-flash" },
    (value) => applied.push(value),
    {
      listModels: async () => {
        listed.push("catalog");
        return catalog;
      },
    },
  );
  const selection = {
    modelId: reasoningModelId,
    reasoningEffort: "high" as const,
  };

  try {
    assert.equal(await service.list(), catalog);
    assert.deepEqual(await service.set(selection), selection);
    assert.deepEqual(listed, ["catalog", "catalog"]);
    assert.deepEqual(applied, [selection]);
    const config = await ConfigStore(home).read();
    assert.equal(config.model, reasoningModelId);
    assert.equal(config.model_config.reasoning_effort, "high");
    assert.deepEqual(service.current(), selection);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("ModelService persists an explicit reasoning disable when none is selected", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cube-model-service-"));
  const home = new HomeManager({ cubeHome: directory });
  await createBootstrap(home).run();
  await ConfigStore(home).update((config) => ({
    ...config,
    model_config: { reasoning_effort: "high" },
  }));
  const service = new ModelService(
    home,
    createSession(),
    { modelId: reasoningModelId, reasoningEffort: "high" },
    () => undefined,
    { listModels: async () => catalog },
  );

  try {
    assert.deepEqual(
      await service.set({ modelId: reasoningModelId, reasoningEffort: "none" }),
      { modelId: reasoningModelId, reasoningEffort: "none" },
    );
    assert.equal((await ConfigStore(home).read()).model_config.reasoning_effort, "none");
    assert.deepEqual(service.current(), {
      modelId: reasoningModelId,
      reasoningEffort: "none",
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("ModelService rejects unknown and unsupported model selections before persistence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cube-model-service-"));
  const home = new HomeManager({ cubeHome: directory });
  await createBootstrap(home).run();
  const previousConfig = await ConfigStore(home).read();
  const applied: ModelSelection[] = [];
  const service = new ModelService(
    home,
    createSession(),
    { modelId: "google/gemini-3.7-flash" },
    (value) => applied.push(value),
    { listModels: async () => catalog },
  );

  try {
    await assert.rejects(
      service.set({ modelId: "openrouter/missing" }),
      /Unknown model/,
    );
    await assert.rejects(
      service.set({ modelId: "openrouter/example/plain", reasoningEffort: "high" }),
      /does not support reasoning/,
    );
    await assert.rejects(
      service.set({ modelId: reasoningModelId, reasoningEffort: "medium" }),
      /does not support reasoning effort: medium/,
    );
    assert.deepEqual(applied, []);
    assert.deepEqual(await ConfigStore(home).read(), previousConfig);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("ModelService reports cache from the latest request, not thread totals", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cube-model-service-"));
  const home = new HomeManager({ cubeHome: directory });
  await createBootstrap(home).run();
  const session = createSession();
  const service = new ModelService(
    home,
    session,
    { modelId: reasoningModelId, reasoningEffort: "high" },
    () => undefined,
    { listModels: async () => catalog },
  );

  try {
    assert.deepEqual(await service.getUsage(), {
      model: reasoningModelId,
      reasoningEffort: "high",
      capabilities: ["tools", "reasoning"],
      capabilitiesComplete: true,
      directory: "/workspace/cube",
      sessionId: "session-test-id",
      contextLimit: 128_000,
      maxOutput: 8_192,
      activeTurnTokens: 18_825,
      promptTokens: 1_107_982,
      completionTokens: 20_730,
      reasoningTokens: 10_231,
      cachedTokens: 8_640,
      cacheCreationTokens: 128,
      totalTokens: 1_128_712,
      threadTitle: "Runtime Refactor",
      threadId: "thread-usage-123",
    });
    const usage = session.getTokenUsage();
    for (const raw of [
      { inputTokens: { total: 18_825, cacheRead: 0, cacheWrite: 0 } },
      { inputTokens: { total: 18_825 } },
      undefined,
    ]) {
      session.getTokenUsage = () => ({ ...usage, raw });
      const metrics = await service.getUsage();
      assert.equal(metrics.cachedTokens, 0);
      assert.equal(metrics.cacheCreationTokens, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
