import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MockLanguageModelV3 } from "ai/test";
import { Agent, isUserAuthoredMessage } from "@mastra/core/agent";
import { Mastra } from "@mastra/core";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { HomeManager, WorkspaceManager, RunnableConfigSchema, createBootstrap } from "@cube/workspace";
import { createNativeSubagents, subagentAllowsTool, type NativeSubagentExecution, type NativeSubagentGate } from "../src/agents/subagent.agent.js";
import { createCubeSkills } from "../src/skills.js";
import { createCubeMastra } from "../src/bootstrap.js";
import { configureCubePermissions } from "../src/permission.js";
import { createSubagentToolsProcessor } from "../src/processors/subagent-tools.processor.js";

function model(reply: (prompt: unknown, tools: string[]) => string | { name: string; args: unknown }) {
  return new MockLanguageModelV3({ doStream: async ({ prompt, tools }) => {
    const output = reply(prompt, (tools ?? []).map(tool => tool.name));
    return { stream: new ReadableStream({ start(stream) {
      stream.enqueue({ type: "stream-start", warnings: [] });
      if (typeof output === "string") {
        stream.enqueue({ type: "text-start", id: "reply" });
        stream.enqueue({ type: "text-delta", id: "reply", delta: output });
        stream.enqueue({ type: "text-end", id: "reply" });
      } else stream.enqueue({ type: "tool-call", toolCallId: "same-call", toolName: output.name, input: JSON.stringify(output.args) });
      stream.enqueue({ type: "finish", finishReason: { unified: typeof output === "string" ? "stop" : "tool-calls", raw: typeof output === "string" ? "stop" : "tool_calls" },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } });
      stream.close();
    } }) };
  } });
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-native-child-"));
  const home = new HomeManager({ cubeHome: path.join(root, "home"), userHome: root });
  // Native SQLite assertions do not need a persistent file; restart is covered in runtime/package smoke.
  home.getMemoryDbPath = () => ":memory:";
  await home.ensure();
  const config = RunnableConfigSchema.parse({ gateway: "api_key/google", model: "google/test" });
  const workspace = new WorkspaceManager(home, root);
  const store = new LibSQLStore({ id: randomUUID(), url: ":memory:" });
  let factory!: ReturnType<typeof createNativeSubagents>;
  const parent = new Agent({ id: "native-parent", model: "google/test", memory: new Memory({ storage: store, options: { generateTitle: false, lastMessages: false } }),
    agents: ({ requestContext }) => factory.readAgents(requestContext),
    inputProcessors: () => [createSubagentToolsProcessor(context => factory.readAgents(context))],
    defaultOptions: ({ requestContext }) => ({ hooks: factory.hooks, onChunk: chunk => requestContext.set("cubeBackgroundRunId", chunk.runId) }) });
  const mastra = new Mastra({ agents: { parent }, storage: store, logger: false });
  const skills = await createCubeSkills(home, workspace, []);
  const mcpTools: Record<string, ReturnType<typeof createTool>> = {};
  factory = createNativeSubagents({ home, config, projectRoot: root, storage: store, parent, skills,
    mcp: { readTools: () => mcpTools, readToolNames: () => Object.keys(mcpTools) }, readPermissions: () => config.permissions });
  const executions: NativeSubagentExecution[] = [];
  const prepare = async (name = "worker", extra = {}) => {
    const execution = await factory.prepare({ id: randomUUID(), projectRoot: root, executionRoot: root, modelId: "google/test",
      definition: { name, source: "builtin", description: "work", instructions: "Fixed role", ...extra },
      instructions: { soul: "Cube", sources: [], explored: [] } });
    executions.push(execution); return execution;
  };
  const run = (execution: NativeSubagentExecution, prompt: string, suspend: (gate: NativeSubagentGate) => Promise<unknown> = async () => { throw new Error("Unexpected gate"); }) =>
    execution.run({ prompt }, { toolCallId: "parent-call", messages: [{ role: "user", content: "PARENT_SECRET" }] }, suspend);
  return { root, home, config, store, factory, parent, prepare, run, skills, mcpTools,
    async close() { await Promise.all(executions.map(execution => execution.dispose())); await mastra.shutdown(); await store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

test("native delegation exposes role tools and stores only actual private child history", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const execution = await f.prepare();
    assert.equal((await execution.agent.listTools({ resolveWebSearch: false })).fetch, undefined);
    const instructions = await execution.agent.getInstructions();
    assert.ok(Array.isArray(instructions));
    assert.equal(instructions.length, 4);
    assert.deepEqual(instructions[1], { role: "system", content: "Cube" });
    assert.deepEqual(instructions[2], { role: "system", content: "Fixed role" });
    const prompts: unknown[] = [];
    execution.agent.model = model((prompt, tools) => { prompts.push(prompt); assert.ok(!tools.some(name => ["worker", "explore", "manage_subagent"].includes(name) || name.startsWith("agent-"))); return "Evidence-backed result"; });
    const result = await f.run(execution, "Assigned focused task");
    assert.equal(result.text, "Evidence-backed result");
    assert.ok(result.runId, "native execution must retain its actual run ID");
    assert.match(JSON.stringify(prompts), /Cube operating instructions/);
    assert.match(JSON.stringify(prompts), /Commands run on the host|NOT an OS sandbox/);
    assert.match(JSON.stringify(prompts), /<name>cube-background<\/name>/);
    assert.doesNotMatch(JSON.stringify(prompts), /# Cube Background Work/);
    assert.doesNotMatch(JSON.stringify(prompts), /PARENT_SECRET/);
    assert.match(JSON.stringify(prompts), /Assigned focused task/);
    const messages = await (await f.store.getStore("memory"))!.listMessages({ threadId: result.threadId!, resourceId: result.resourceId!, perPage: 100, page: 0 });
    assert.match(JSON.stringify(messages.messages), /Assigned focused task/);
    assert.match(JSON.stringify(messages.messages), /Evidence-backed result/);
    assert.notEqual(result.resourceId, f.root);
    let dispatched = 0;
    f.factory.setDispatch(async request => { dispatched++; assert.equal(request.input.prompt, "Delegate task"); assert.equal(request.parentThreadId, "parent-thread"); return { id: "accepted-job" }; });
    let calls = 0;
    f.parent.model = model((_prompt, tools) => { assert.ok(tools.includes("worker") && tools.includes("explore")); assert.ok(!tools.some(name => name.startsWith("agent-"))); return calls++ === 0 ? { name: "worker", args: { prompt: "Delegate task" } } : "Parent continued"; });
    const context = new RequestContext(); context.set("controller", { threadId: "parent-thread" });
    const output = await f.parent.stream("PARENT_SECRET", { requestContext: context, maxSteps: 3 });
    await output.consumeStream();
    assert.equal(dispatched, 1);
    assert.equal(await output.text, "Parent continued");
  } finally { await f.close(); }
});

test("child executes MCP fetch without a native fetch tool", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    f.config.permissions.allow_for = ["fetch"];
    let fetched = "";
    f.mcpTools.fetch = createTool({
      id: "fetch", description: "Fetch URL content from MCP", inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => { fetched = url; return "MCP_FETCH_CONTENT"; },
    });
    const child = await f.prepare();
    const prompts: unknown[] = []; let calls = 0;
    child.agent.model = model((prompt, tools) => {
      prompts.push(prompt); assert.ok(tools.includes("fetch"));
      return calls++ === 0 ? { name: "fetch", args: { url: "https://example.com" } } : "Fetched through MCP";
    });
    assert.equal((await f.run(child, "Read this URL")).text, "Fetched through MCP");
    assert.equal(fetched, "https://example.com");
    assert.match(JSON.stringify(prompts), /MCP_FETCH_CONTENT/);
  } finally { await f.close(); }
});

test("role tool naming preserves active filters and refuses collisions without changing supplied tools", async () => {
  const worker = new Agent({ id: "role-name-test", name: "worker", model: "google/test", instructions: "work" });
  const processor = createSubagentToolsProcessor(() => ({ worker }));
  const delegate = { execute: async () => "delegate" };
  const read = { execute: async () => "read" };
  const tools = { "agent-worker": delegate, read_file: read };
  const result = await processor.processInputStep!({ tools, activeTools: ["agent-worker", "read_file"] } as any) as any;
  assert.deepEqual(Object.keys(result.tools).sort(), ["read_file", "worker"]);
  assert.deepEqual(result.activeTools, ["worker", "read_file"]);
  assert.equal(result.tools.worker, delegate);
  assert.equal(tools["agent-worker"], delegate);
  assert.throws(() => processor.processInputStep!({ tools: { ...tools, worker: read } } as any), /conflicts with an existing tool/);
});

test("same-role jobs keep identical approval IDs separate and cancelled questions continue", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const gates: { gate: NativeSubagentGate; answer: (data: unknown) => void }[] = [];
    const children = await Promise.all([f.prepare(), f.prepare()]);
    const prompts: unknown[][] = [[], []];
    for (const [index, child] of children.entries()) {
      let calls = 0;
      child.agent.model = model(prompt => { prompts[index]!.push(prompt); return calls++ === 0 ?
        { name: "write_file", args: { path: `child-${index}.txt`, content: "CHILD_OK" } } : "Report actual outcome"; });
    }
    const runs = children.map((child, index) => f.run(child, `PRIVATE_TASK_${index}`, gate => new Promise(resolve => { gates[index] = { gate, answer: resolve }; })));
    for (let i = 0; gates.filter(Boolean).length < 2 && i < 300; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(gates.filter(Boolean).length, 2);
    assert.equal(gates[0]!.gate.toolCallId, gates[1]!.gate.toolCallId);
    assert.notEqual(gates[0]!.gate.runId, gates[1]!.gate.runId);
    assert.ok(children[0]!.tools.hasPreview("same-call"));
    assert.ok("preview" in gates[0]!.gate.args);
    gates[0]!.answer({ approved: true }); gates[1]!.answer({ approved: false, reason: "User declined tool execution." });
    const results = await Promise.all(runs);
    assert.equal(await readFile(path.join(f.root, "child-0.txt"), "utf8"), "CHILD_OK");
    await assert.rejects(readFile(path.join(f.root, "child-1.txt")), /ENOENT/);
    assert.notEqual(results[0]!.threadId, results[1]!.threadId);
    assert.match(JSON.stringify(prompts[1]), /User declined tool execution/);
    assert.doesNotMatch(JSON.stringify(prompts[0]), /PRIVATE_TASK_1/);
    const asking = await f.prepare(); let calls = 0; const questionPrompts: unknown[] = [];
    asking.agent.model = model(prompt => { questionPrompts.push(prompt); return calls++ === 0 ?
      { name: "ask_user", args: { question: "Continue?" } } : "Question cancelled; continuing normally"; });
    assert.match((await f.run(asking, "Ask once", async gate => { assert.equal(gate.approval, false); assert.equal(gate.toolName, "ask_user"); return { cancelled: true }; })).text, /continuing/);
    assert.match(JSON.stringify(questionPrompts), /User declined to answer the question/);
  } finally { await f.close(); }
});

test("native allow/deny, role tools and skill scopes do not alter parent policy", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const allowedDir = path.join(f.root, ".agents", "skills", "allowed");
    await mkdir(allowedDir, { recursive: true });
    await writeFile(path.join(allowedDir, "SKILL.md"), "---\nname: allowed\ndescription: Allowed skill\n---\nALLOWED_BODY");
    f.config.permissions.allow_for = ["write_file"];
    f.config.permissions.require_approval_for = [];
    const execution = await f.prepare("scoped", { skills: ["allowed"], tools: ["write_file", "skill"] });
    const prompts: unknown[] = []; let calls = 0;
    execution.agent.model = model((prompt, tools) => { prompts.push(prompt);
      assert.ok(tools.every(name => ["write_file", "skill"].includes(name)));
      return calls++ === 0 ? { name: "write_file", args: { path: "allowed.txt", content: "ALLOW" } } : "Allowed write"; });
    await f.run(execution, "Write allowed file");
    assert.equal(await readFile(path.join(f.root, "allowed.txt"), "utf8"), "ALLOW");
    assert.doesNotMatch(JSON.stringify(prompts[0]), /ALLOWED_BODY/);
    assert.doesNotMatch(JSON.stringify(prompts[0]), /<name>cube-background<\/name>/);
    await assert.rejects(f.prepare("missing", { skills: ["missing"] }), /Unavailable child skill/);
    f.config.permissions.deny_for = ["write_file"]; calls = 0;
    execution.agent.model = model(() => calls++ === 0 ? { name: "write_file", args: { path: "denied.txt", content: "DENY" } } : "Denied write");
    await f.run(execution, "Denied write");
    await assert.rejects(readFile(path.join(f.root, "denied.txt")), /ENOENT/);
    assert.equal(subagentAllowsTool({ name: "explore", source: "builtin", instructions: "", description: "" }, "write_file"), false);
    assert.equal(subagentAllowsTool({ name: "custom", source: "project", instructions: "", description: "", tools: ["read_file"], disallowedTools: ["read_file"] }, "read_file"), false);
  } finally { await f.close(); }
});

test("native children fail closed for retired permission rules", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    f.config.permissions.require_approval_for = ["create_file"];
    f.config.permissions.allow_for = ["write_file", "execute_command"];
    const child = await f.prepare(); let calls = 0; const prompts: unknown[] = [];
    child.agent.model = model(prompt => { prompts.push(prompt); return calls++ === 0 ?
      { name: "write_file", args: { path: "retired.txt", content: "MUST_NOT_WRITE" } } : "Permission denied"; });
    await f.run(child, "Attempt a write with retired permission names");
    await assert.rejects(readFile(path.join(f.root, "retired.txt")), /ENOENT/);
    assert.match(JSON.stringify(prompts), /Permission denied/);
    calls = 0; prompts.length = 0;
    child.agent.model = model(prompt => { prompts.push(prompt); return calls++ === 0 ?
      { name: "execute_command", args: { command: "echo SHOULD_NOT_EXECUTE", reason: "Test retired rule" } } : "Permission denied"; });
    await f.run(child, "Attempt a command with retired permission names");
    assert.match(JSON.stringify(prompts), /Permission denied: execute_command/);
    assert.doesNotMatch(JSON.stringify(prompts), /completed.*exit/);
  } finally { await f.close(); }
});

test("cancelled native questions retain actual private history identity", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const child = await f.prepare(); const abort = new AbortController();
    child.agent.model = model(() => ({ name: "ask_user", args: { question: "Continue?" } }));
    await assert.rejects(child.run({ prompt: "TASK_BEFORE_CANCEL" }, { toolCallId: "parent-call", messages: [], abortSignal: abort.signal }, async () => {
      abort.abort(new Error("Test cancellation")); throw abort.signal.reason;
    }), /Test cancellation/);
    const history = (child as NativeSubagentExecution & { history?: { threadId?: string; resourceId?: string } }).history;
    assert.ok(history?.threadId && history.resourceId);
    const messages = await (await f.store.getStore("memory"))!.listMessages({ threadId: history.threadId, resourceId: history.resourceId, perPage: 100, page: 0 });
    assert.match(JSON.stringify(messages.messages), /TASK_BEFORE_CANCEL/);
  } finally { await f.close(); }
});

test("Controller dispatches native roles and completion preserves a queued parent prompt", { timeout: 30000 }, async () => {
  const f = await fixture();
  await createBootstrap(f.home).run();
  const composition = await createCubeMastra(f.home, new WorkspaceManager(f.home, f.root), f.config);
  const session = await composition.controller.createSession({ resourceId: f.root });
  const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>(); const prompts: string[] = []; const errors: unknown[] = [];
  let dispatched = 0; let calls = 0; let turns = 0;
  composition.subagents.setDispatch(async request => {
    dispatched++; assert.equal(request.input.prompt, "Delegate task"); assert.equal(request.parentThreadId, "controller-parent");
    assert.equal(request.input.threadId, undefined);
    assert.equal(request.input.resourceId, undefined);
    return { id: "controlled-job" };
  });
  const base = model((prompt, tools) => {
    prompts.push(JSON.stringify(prompt)); assert.ok(tools.includes("worker"));
    return calls++ === 0 ? { name: "worker", args: { prompt: "Delegate task" } } : "Parent continued";
  });
  composition.agent.model = new MockLanguageModelV3({ doStream: async options => {
    if (calls === 1) { started.resolve(); await release.promise; }
    return base.doStream(options);
  } });
  const stop = session.subscribe(event => {
    if (event.type === "error") { errors.push(event.error); started.reject(event.error); ended.reject(event.error); }
    if (event.type === "agent_end" && ++turns >= 2) ended.resolve();
  });
  try {
    await configureCubePermissions(session, f.config.permissions);
    await session.thread.create({ id: "controller-parent" });
    const first = session.followUp({ content: "Delegate once" });
    await started.promise;
    await session.followUp({ content: "QUEUED_PARENT_PROMPT" });
    const record = { id: "controlled-job", parentThreadId: "controller-parent", projectRoot: f.root, agent: "worker",
      pendingDelivery: "subagent-controlled-job", result: { text: "CHILD_EVIDENCE", toolActivity: [], status: "completed" as const } };
    const delivered = composition.deliverSubagentResult(record, true);
    release.resolve();
    await delivered; await first; await ended.promise;
    await composition.deliverSubagentResult(record, true);
    assert.equal(dispatched, 1, JSON.stringify(prompts.map(text => JSON.parse(text).filter((message: { role: string }) => message.role === "tool")))); assert.equal(session.followUps.count(), 0); assert.deepEqual(errors, []);
    const messages = await session.thread.listMessages({ threadId: "controller-parent" });
    const delegated = messages.flatMap(message => message.content.parts ?? []).filter(part =>
      part.type === "tool-invocation" && part.toolInvocation.args?.prompt === "Delegate task");
    assert.equal(delegated.length, 1);
    assert.equal((delegated[0] as any).toolInvocation.toolName, "worker");
    assert.equal(messages.filter(message => message.id === record.pendingDelivery).length, 1);
    assert.equal(messages.filter(message => isUserAuthoredMessage(message) && JSON.stringify(message.content).includes("QUEUED_PARENT_PROMPT")).length, 1);
    assert.ok(prompts.some(prompt => prompt.includes("CHILD_EVIDENCE")));
    const deliveredSignal = messages.find(message => message.id === record.pendingDelivery);
    assert.match(JSON.stringify(deliveredSignal), /manage_subagent/);
    assert.match(JSON.stringify(deliveredSignal), /manage_task is only for command processes/);
    const failure = { id: "failed-job", parentThreadId: "controller-parent", projectRoot: f.root, agent: "worker",
      pendingDelivery: "subagent-failed-job", status: "failed", error: "HTTP 429: account quota exhausted" };
    await composition.deliverSubagentResult(failure, false);
    const failedMessages = await session.thread.listMessages({ threadId: "controller-parent" });
    const failedSignal = failedMessages.find(message => message.id === failure.pendingDelivery);
    assert.match(JSON.stringify(failedSignal), /HTTP 429: account quota exhausted/);
    assert.match(JSON.stringify(failedSignal), /manage_subagent/);
    assert.match(JSON.stringify(failedSignal), /partial saved work/);
    const signalText = failedSignal!.content.parts?.filter(part => part.type === "text").map(part => part.text).join("") ?? "";
    assert.match(signalText, /"evidence":\{"tool":"manage_subagent","action":"get","id":"failed-job","view":"transcript"\}/);
  } finally {
    release.resolve(); stop(); session.abort();
    session.thread.detachFromCurrent(); await session.thread.clearAndReleaseLock();
    await composition.shutdown(); await f.close();
  }
});

test("native provider errors retain their cause instead of becoming an empty final report", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const child = await f.prepare();
    child.agent.model = new MockLanguageModelV3({ doStream: async () => ({
      stream: new ReadableStream({ start(stream) {
        stream.enqueue({ type: "stream-start", warnings: [] });
        stream.enqueue({ type: "error", error: new Error("HTTP 429: account quota exhausted") });
        stream.close();
      } }),
    }) });
    await assert.rejects(f.run(child, "Assigned task"), /HTTP 429: account quota exhausted/);
  } finally { await f.close(); }
});
