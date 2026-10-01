import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { measure, report } from "./harness.mjs";
import type { Session } from "../cube-agent/src/index.js";
import type { ThreadService } from "../cube-runtime/src/services/thread.service.js";
import type { SlashCommandContext } from "../cube-runtime/src/slash-commands.js";

// Resolve installed Mastra from its owner, without adding root dependencies.
const agentRequire = createRequire(new URL("../cube-agent/package.json", import.meta.url));
const importStarted = performance.now();
const [workspaceApi, { PromptService }, { MessageList }, native, { RequestContext },
  { LibSQLStore }, { estimateTokens, selectPrunedTools }, { makeRequestFrame }, instructions,
  { createAgentsMdProcessor }, { createCubeSkills }, { createSkillsProcessor }] = await Promise.all([
  import("../cube-workspace/src/index.js"),
  import("../cube-runtime/src/services/prompt.service.js"),
  import("../cube-tui/src/components/message-list.js"),
  import(pathToFileURL(agentRequire.resolve("@mastra/core/agent")).href),
  import(pathToFileURL(agentRequire.resolve("@mastra/core/request-context")).href),
  import(pathToFileURL(agentRequire.resolve("@mastra/libsql")).href),
  import("../cube-agent/src/context.js"),
  import("../cube-agent/src/processors/context.processor.js"),
  import("../cube-agent/src/prompts/system.prompt.js"),
  import("../cube-agent/src/processors/agents-md.processor.js"),
  import("../cube-agent/src/skills.js"),
  import("../cube-agent/src/processors/skills.processor.js"),
]);
const importsMs = performance.now() - importStarted;
const { CubeHome, WorkspaceManager, createBootstrap, ConfigStore, AuthStore, ModelCatalogStore } = workspaceApi;
const root = await mkdtemp(path.join(os.tmpdir(), "cube-internal-bench-"));
const home = CubeHome({ cubeHome: path.join(root, "home"), userHome: root });
const project = path.join(root, "project");
const workspace = new WorkspaceManager(home, project);
let storage: InstanceType<typeof LibSQLStore> | undefined;
const memoryBefore = process.memoryUsage();

function messages(count: number, outputCharacters = 512) {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`, threadId: "benchmark", resourceId: "benchmark",
    createdAt: new Date(1_700_000_000_000 + index),
    role: index % 4 === 1 || index % 4 === 3 ? "assistant" : "user",
    content: { format: 2, parts: index % 4 === 1 ? [{
      type: "tool-invocation", toolInvocation: {
        state: "result", toolCallId: `tool-${index}`, toolName: "read_file",
        args: { path: "fixture.ts" }, result: "local file output\n".padEnd(outputCharacters, "x"),
      },
    }] : [{ type: "text", text: `Local coding conversation ${index}: inspect fixture.ts.` }] },
  }));
}

try {
  await mkdir(project, { recursive: true });
  await createBootstrap(home).run();
  await writeFile(path.join(project, "AGENTS.md"), "Project instructions: preserve user changes.\n".repeat(40));
  await writeFile(home.getAgentsPath(), "Global instructions: use local tools.\n");
  await new AuthStore(home).replaceApiKey("google", "synthetic-benchmark-key");
  await ModelCatalogStore(home).write({
    api_key: { google: {
      name: "Benchmark Google", updatedAt: "2026-01-01T00:00:00.000Z", sourceKey: "0".repeat(64),
      models: Array.from({ length: 100 }, (_, index) => ({
        modelId: `google/benchmark-${index}`, name: `Benchmark ${index}`,
        reasoning: true, tool_call: true, limit: { context: 256_000, output: 16_384 },
      })),
    } }, oauth: {}, local: {},
  });
  for (let index = 0; index < 24; index++) {
    const dir = path.join(index < 16 ? path.join(project, ".agents", "skills") : home.getSkillDir(), `bench-${index}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"),
      `---\nname: bench-${index}\ndescription: Local benchmark skill ${index}\n---\n` +
      "Use local evidence and preserve existing changes.\n".repeat(40));
  }

  await measure("workspace.load", () => Promise.all([
    ConfigStore(home).read(), new AuthStore(home).read(), ModelCatalogStore(home).read(),
    instructions.loadInstructionSnapshot(home, workspace),
  ]), ([config, auth, catalog, snapshot]) => {
    assert.equal(config.memory.storage.provider, "sqlite");
    assert.equal(auth.api_keys.google?.api_key, "synthetic-benchmark-key");
    assert.equal(catalog.api_key.google?.models.length, 100);
    assert.equal(snapshot.sources.length, 2);
  }, { iterations: 30, warmup: 3 });
  await measure("skills.discover", async () => (await createCubeSkills(home, workspace, [])).list(),
    (catalog) => assert.equal(catalog.length, 24), { iterations: 10, warmup: 2 });
  const skills = await createCubeSkills(home, workspace, []);
  await skills.list();
  await measure("skills.cached", () => skills.list(), (catalog) => assert.equal(catalog.length, 24));

  let databaseIndex = 0;
  await measure("sqlite.init", async () => {
    const database = new LibSQLStore({ id: "benchmark-init", url: `file:${path.join(root, `init-${databaseIndex++}.db`)}` });
    try { await database.init(); return database; }
    catch (error) { await database.close(); throw error; }
  }, async (database) => {
    try { assert.ok(await database.getStore("memory")); }
    finally { await database.close(); }
  }, { iterations: 5, warmup: 1 });
  storage = new LibSQLStore({ id: "benchmark-storage", url: `file:${home.getMemoryDbPath()}` });
  await storage.init();
  const memory = await storage.getStore("memory");
  assert.ok(memory);
  await memory.saveThread({ thread: {
    id: "benchmark", resourceId: "benchmark", title: "Local benchmark",
    createdAt: new Date(), updatedAt: new Date(),
  } });
  await memory.saveMessages({ messages: messages(100) });
  await measure("sqlite.read.100", () => memory.listMessages({
    threadId: "benchmark", perPage: false, orderBy: { field: "createdAt", direction: "ASC" },
  }), (result) => {
    assert.equal(result.messages.length, 100);
    assert.equal(result.messages[0].id, "message-0");
    assert.equal(result.messages.at(-1)?.id, "message-99");
  }, { iterations: 30 });
  await measure("sqlite.checkpoint.write", () => memory.patchThread({
    id: "benchmark", metadata: { cubeContext: { prunedToolCallIds: ["tool-1"] } },
  }), async () => {
    const thread = await memory.getThreadById({ threadId: "benchmark" });
    assert.deepEqual(thread?.metadata?.cubeContext, { prunedToolCallIds: ["tool-1"] });
  }, { iterations: 30 });

  // Dispatch/queue boundaries are local doubles; orchestration and history IO are real.
  let dispatched = "";
  let dispatches = 0;
  const queue: Array<{ content: string }> = [];
  const session = {
    run: { isRunning: () => false },
    followUp: async ({ content }: { content: string }) => { dispatched = content; dispatches++; },
    followUps: { dequeue: () => queue.shift(), requeue: (item: { content: string }) => queue.unshift(item), count: () => queue.length },
    emit: () => undefined,
  } as unknown as Session;
  const thread = { current: () => "benchmark", ensureForPrompt: async () => "benchmark" } as unknown as ThreadService;
  const commands = { gateway: { readiness: async () => ({ ready: true }) } } as unknown as SlashCommandContext;
  const prompt = new PromptService(home, session, thread, commands, (callback) => callback());
  await measure("runtime.submit", (index) => prompt.submit(`benchmark prompt ${index}`), (result, index) => {
    assert.equal(result.kind, "submitted");
    assert.equal(dispatched, `benchmark prompt ${index}`);
    assert.equal(dispatches, index + 1);
  });
  await measure("runtime.command", () => prompt.submit("/exit"), (result) => assert.equal(result.kind, "exit-requested"));
  await measure("runtime.queue.cancel.100", () => prompt.cancelLatestQueued(), (result) => {
    assert.equal(result, "queued-99");
    assert.equal(queue.length, 99);
    assert.equal(queue[0]?.content, "queued-0");
    assert.equal(queue.at(-1)?.content, "queued-98");
  }, { prepare: () => {
    queue.splice(0, queue.length, ...Array.from({ length: 100 }, (_, index) => ({ content: `queued-${index}` })));
  } });
  const history = await workspaceApi.HistoryStore(home).read();
  assert.ok(history.some((entry) => entry.text === "benchmark prompt 0"));

  const snapshot = await instructions.loadInstructionSnapshot(home, workspace);
  const agents = createAgentsMdProcessor(() => instructions.formatAgentsContext(snapshot.sources));
  await measure("instructions.inject", () => agents.processLLMRequest!({
    prompt: [{ role: "system", content: snapshot.soul }, { role: "user", content: "Inspect fixture.ts" }],
    state: { usersFromAnchor: 1 },
  } as any), (result) => {
    assert.equal(result?.prompt?.length, 3);
    assert.match(JSON.stringify(result?.prompt?.[1]), /agents_instructions/);
    assert.equal(result?.prompt?.[2]?.content, "Inspect fixture.ts");
  });
  const skillProcessor = createSkillsProcessor(skills);
  let skillInput: InstanceType<typeof native.MessageList>;
  let skillState: Record<string, unknown>;
  await measure("skills.inject", () => skillProcessor.processInput!({
    messageList: skillInput, requestContext: new RequestContext(), state: skillState,
  } as any), () => {
    assert.equal(skillState.skillError, undefined);
    const message = skillInput.get.input.db()[0];
    assert.equal(message.content.parts.length, 2);
    assert.match(message.content.parts[0].text, /skill_instructions/);
    assert.equal(message.content.metadata.cube.displayText, "Use $bench-0 to inspect fixture.ts");
  }, { prepare: () => {
    skillState = {};
    skillInput = new native.MessageList();
    skillInput.add({ role: "user", content: "Use $bench-0 to inspect fixture.ts" }, "input");
  }, iterations: 30 });

  for (const count of [100, 500]) {
    const conversation = messages(count, 16_384);
    const list = new native.MessageList({ filterIncompleteToolCalls: true });
    list.add(conversation, "memory");
    const llmPrompt = [{ role: "system", content: snapshot.soul }, ...await list.get.all.aiV5.llmPrompt()];
    await measure(`context.estimate.${count}`, () => estimateTokens(llmPrompt), (tokens) => assert.ok(tokens! > 0));
    await measure(`context.prune.${count}`, () => selectPrunedTools(conversation as any, { prunedToolCallIds: [] }, new Set(["skill"])), (ids) => {
      assert.ok(ids.length > 0);
      assert.ok(ids.includes("tool-1"));
      assert.ok(!ids.includes(`tool-${count - 3}`));
    });
    const createFrame = () => makeRequestFrame({
      threadId: "benchmark", messages: conversation as any, prompt: llmPrompt,
      protectedMessages: new WeakSet(), toolsTokens: 1000, limits: { context: 256_000 },
      requestContext: new RequestContext(), isCurrent: () => true,
    });
    await measure(`context.frame.${count}`, createFrame,
      (frame) => assert.equal(frame.project({ prunedToolCallIds: [] }).length, llmPrompt.length), { iterations: 10, warmup: 2 });
    const frame = createFrame();
    await measure(`context.select.${count}`, () => frame.select({ prunedToolCallIds: [] }, 32_000), (selection) => {
      assert.ok(selection);
      assert.ok(selection.text.length > 0);
      assert.notEqual(selection.boundary, "message-0");
    }, { iterations: 20, warmup: 2 });
  }

  for (const count of [40, 400]) {
    const list = new MessageList();
    for (let index = 0; index < count; index++) list.addMessage({
      id: `render-${index}`, role: index % 2 ? "assistant" : "user", status: "done",
      content: index % 2 ? `Review ${index}\n\nUse local **evidence**.\n\n\`\`\`typescript\nconst value = ${index};\n\`\`\`\n\n- Preserve existing changes.` : `Inspect fixture ${index}.`,
    });
    const chunks = Array.from({ length: 110 }, (_, index) => ({
      id: "stream", role: "assistant", content: { parts: [{ type: "text", text: `Streaming revision ${index}: ` + "local output ".repeat(index + 1) }] },
    }));
    await measure(`stream.reconcile.${count}`, (index) => list.applySessionMessage(chunks[index % chunks.length]!, true), (_, index) => {
      assert.equal(list.getMessages().at(-1)!.content, chunks[index % chunks.length]!.content.parts[0]!.text);
      assert.equal(list.getMessages().length, count + 1);
    });
    for (const width of [80, 120]) {
      const verify = (lines: string[]) => assert.ok(lines.length > count);
      await measure(`render.cold.${count}x${width}`, () => { list.invalidate(); return list.render(width); }, verify,
        { iterations: 20, warmup: 2 });
      await measure(`render.cached.${count}x${width}`, () => list.render(width), verify);
    }
  }
  report({
    suite: "internal", importsMs, memoryBefore, memoryAfter: process.memoryUsage(),
    fixtures: { catalogModels: 100, skills: 24, storedMessages: 100, contextMessages: [100, 500], transcriptMessages: [40, 400] },
    exclusions: ["provider/model latency", "LLM summarization", "terminal paint/IO", "full application boot"],
  });
} finally {
  await storage?.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
