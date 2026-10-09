import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { createMemoryAgent } from "../src/agents/memory.agent.js";
import { createSummarizerAgent, summarizeConversation } from "../src/agents/summarizer.agent.js";
import { RequestContext } from "@mastra/core/request-context";
import { memoryWriterBudget } from "../src/durable-memory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigStore, HomeManager, WorkspaceManager, ModelManager, RunnableConfigSchema, createBootstrap } from "@cube/workspace";
import { createCubeMastra, type CubeMastraComposition } from "../src/bootstrap.js";

export const generated = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
  warnings: [],
});

test("auxiliary agents own no chat tools, processors or conversation memory", async () => {
  const model = new MockLanguageModelV3({ doGenerate: async options => {
    assert.ok(!options.tools?.length);
    return generated("summary");
  } });
  const memory = createMemoryAgent(model), compact = createSummarizerAgent(model);
  assert.equal(memory.id, "cube-memory");
  assert.equal(compact.id, "cube-compactor");
  assert.equal(await memory.getMemory(), undefined);
  assert.equal(await compact.getMemory(), undefined);
  assert.equal((await memory.generate("data")).text, "summary");
  assert.equal((await compact.generate("data")).text, "summary");
});

test("writer budgets derive from actual limits and refuse insufficient or unknown capacity", () => {
  assert.deepEqual(memoryWriterBudget({ context: 256000, output: 32000 }), { input: 32768, output: 8192 });
  assert.deepEqual(memoryWriterBudget({ context: 32000, output: 4000, input: 3000 }), { input: 3000, output: 1600 });
  assert.throws(() => memoryWriterBudget({}), /known/);
  assert.throws(() => memoryWriterBudget({ context: 1000, output: 1000 }), /insufficient/);
});

test("compact generation rejects unfit requests before calling the model and caps output", async () => {
  let calls = 0;
  const model = new MockLanguageModelV3({ doGenerate: async options => {
    calls++;
    assert.equal(options.maxOutputTokens, 512);
    assert.ok(!options.tools?.length);
    return generated("bounded summary");
  } });
  const input = {
    text: "Conversation to summarize",
    maxOutputTokens: 8192,
    signal: new AbortController().signal,
    requestContext: new RequestContext(),
  };
  await assert.rejects(summarizeConversation(model, {}, input), /known context\/output limits/);
  await assert.rejects(
    summarizeConversation(model, { context: 256000, output: 512, input: 1 }, input),
    /cannot fit/,
  );
  assert.equal(calls, 0);
  const result = await summarizeConversation(model, { context: 256000, output: 512 }, input);
  assert.equal(result.text, "bounded summary");
  assert.equal(calls, 1);
});

test("registered summarizer captures inherited model per call and explicit override stays routed", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cube-aux-model-"));
  let composition: CubeMastraComposition | undefined;
  try {
    const home = new HomeManager({ cubeHome: path.join(root, "home") });
    await createBootstrap(home).run();
    const parsed = await ConfigStore(home).read();
    const config = RunnableConfigSchema.parse({ ...parsed, gateway: "api_key/google", model: "google/main",
      memory: { ...parsed.memory, durable: { ...parsed.memory.durable, model: "google/memory-override" } } });
    t.mock.method(ModelManager.prototype, "getCatalog", async () => ({ updatedAt: new Date().toISOString(), providers: {
      google: { name: "Google", models: ["main", "override", "next"].map(name => ({ modelId: `google/${name}`, name, limit: { context: 256000, output: 32000 } })) },
    } }));
    composition = await createCubeMastra(home, new WorkspaceManager(home, root), config);
    assert.equal(config.memory.compaction.model, "inherit");
    assert.equal(config.memory.durable.model, "google/memory-override");
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    composition.agent.model = new MockLanguageModelV3({ doGenerate: async () => { entered(); await gate; return generated("first-model"); } });
    const summarizer = composition.mastra.getAgentById("cube-compactor");
    const running = summarizer.generate("data", { maxSteps: 1 });
    await ready;
    composition.agent.model = new MockLanguageModelV3({ doGenerate: async () => generated("next-model") });
    composition.agent.setToolModel("cube-api/google/next");
    release();
    assert.equal((await running).text, "first-model");
    assert.equal((await summarizer.generate("data", { maxSteps: 1 })).text, "next-model");
    await composition.shutdown();
    config.memory.compaction.model = "google/override";
    composition = await createCubeMastra(home, new WorkspaceManager(home, root), config);
    const resolutions: unknown[] = [];
    t.mock.method(composition.agent, "getModel", async options => { resolutions.push(options.modelConfig); return new MockLanguageModelV3({ doGenerate: async () => generated("override") }); });
    const fixed = composition.mastra.getAgentById("cube-compactor");
    assert.equal((await fixed.generate("data", { maxSteps: 1 })).text, "override");
    composition.agent.setToolModel("cube-api/google/next");
    assert.equal((await fixed.generate("data", { maxSteps: 1 })).text, "override");
    assert.ok(resolutions.length >= 2);
    assert.ok(resolutions.every(value => JSON.stringify(value).includes("cube-api/google/override")));
  } finally {
    await composition?.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
