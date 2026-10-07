import assert from "node:assert/strict";
import test from "node:test";
import { Agent, MessageList, createSignal } from "@mastra/core/agent";
import { InMemoryStore } from "@mastra/core/storage";
import { Memory } from "@mastra/memory";
import { MockLanguageModelV3 } from "ai/test";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Mastra } from "@mastra/core";
import { AgentController } from "@mastra/core/agent-controller";
import { createAgentsMdProcessor } from "../src/processors/agents-md.processor.js";

const context = "<agents_instructions>Use pnpm.</agents_instructions>";

test("native Session keeps AGENTS at the request prefix without adding a transcript row", async () => {
  const requests: any[][] = [];
  const model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
    requests.push(prompt);
    return { stream: new ReadableStream({ start(controller) {
      for (const chunk of [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "done" },
        { type: "text-end", id: "text" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        } },
      ]) controller.enqueue(chunk);
      controller.close();
    } }) };
  } });
  const agent = new Agent({
    id: "session-context", name: "Session context", instructions: "Cube", model,
    inputProcessors: [createAgentsMdProcessor(() => context)],
  });
  const controller = new AgentController({
    id: "controller", agent, memory: new Memory({ options: { generateTitle: false, lastMessages: 100 } }),
    modes: [{ id: "default", name: "Default", metadata: { default: true } }],
  });
  const mastra = new Mastra({ storage: new InMemoryStore(), agentControllers: { controller }, logger: false });
  const session = await controller.createSession({ resourceId: "workspace" });
  try {
    await session.thread.create({ id: "session-thread" });
    await session.followUp({ content: "actual user request" });
    const prompt = requests.at(-1)!;
    assert.ok(prompt);
    const index = prompt.findIndex((message) => JSON.stringify(message).includes("Use pnpm."));
    assert.ok(index >= 0);
    assert.equal(index, prompt.findIndex((message) => message.role !== "system"));
    assert.match(JSON.stringify(prompt[index + 1]), /actual user request/);
    await session.followUp({ content: "second request" });
    assert.deepEqual(requests.at(-1)!.slice(0, index + 1), prompt.slice(0, index + 1));
    assert.match(JSON.stringify(requests.at(-1)![index + 1]), /actual user request/);
    const messages = await session.thread.listMessages({ threadId: "session-thread" });
    assert.doesNotMatch(JSON.stringify(messages), /Use pnpm|agents_instructions/);
  } finally {
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
    await mastra.shutdown();
  }
});

test("AGENTS stays before history across native reminders and tool steps", async () => {
  const list = new MessageList();
  list.addSystem({ role: "system", content: "Cube" });
  list.add({ id: "older", role: "user", createdAt: new Date(1000), content: {
    format: 2, parts: [{ type: "text", text: "older prompt" }],
  } }, "memory");
  list.addSignal(createSignal({ type: "user", createdAt: new Date(2000), contents: "<agents_instructions>user text</agents_instructions>" }), { source: "input" });
  const id = list.get.input.db().at(-1)!.id;
  const state = {};
  const processor = createAgentsMdProcessor(() => context);
  list.addSignal(createSignal({ type: "reactive", createdAt: new Date(3000), tagName: "system-reminder", contents: "native reminder" }));
  // Native signals assign delivery time themselves; supplied createdAt becomes
  // acceptedAt. Keep this tool response after their actual stored timestamps.
  const responseTime = new Date(Math.max(...list.get.all.db().map((message) => message.createdAt.getTime())) + 1);
  list.add({
    id: "response", role: "assistant", createdAt: responseTime,
    content: { format: 2, parts: [{ type: "tool-invocation", toolInvocation: {
      state: "result", toolCallId: "call", toolName: "read_file",
      args: { path: "src/app.ts" }, result: "source",
    } }] },
  }, "response");
  const steps = [{ toolCalls: [{ input: { path: "src/app.ts" } }] }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = structuredClone(list.get.all.db());
    await processor.processInputStep!({ messageList: list, state, steps } as any);
    const prompt = await list.get.all.aiV6.llmPrompt();
    const original = structuredClone(prompt);
    const result = await processor.processLLMRequest!({ prompt, state } as any);
    assert.ok(result?.prompt);
    const injected = result.prompt.findIndex((message) => JSON.stringify(message).includes("Use pnpm."));
    assert.equal(injected, 1);
    assert.match(JSON.stringify(result.prompt[injected + 1]), /older prompt/);
    assert.deepEqual(result.prompt.filter((_, index) => index !== injected), original);
    assert.deepEqual(prompt, original);
    assert.deepEqual(list.get.all.db(), before);
  }
  list.removeByIds([id]);
  await processor.processInputStep!({ messageList: list, state, steps } as any);
  const result = await processor.processLLMRequest!({ prompt: await list.get.all.aiV6.llmPrompt(), state } as any);
  assert.match(JSON.stringify(result?.prompt?.[1]), /Use pnpm/);
  assert.doesNotMatch(JSON.stringify(list.get.all.db()), /Use pnpm/);
});

test("discovery extracts file paths and patch moves once, never shell arguments", async () => {
  const paths: string[][] = [];
  const processor = createAgentsMdProcessor(() => context, async (targets) => { paths.push(targets); });
  const list = new MessageList();
  const calls = [
    { toolName: "list_files", args: { path: "src" } },
    { toolName: "apply_patch", args: { patch: "*** Begin Patch\n*** Update File: old/a.ts\n*** Move to: next/a.ts\n@@\n-old\n+new\n*** End Patch" } },
    { toolName: "execute_command", args: { path: "secret", command: "cat secret/AGENTS.md" } },
  ];
  for (const [index, call] of calls.entries()) list.add({
    id: `response-${index}`, role: "assistant", createdAt: new Date(),
    content: { format: 2, parts: [{ type: "tool-invocation", toolInvocation: {
      ...call, state: "result", toolCallId: `call-${index}`, result: "done",
    } }] },
  }, "response");
  const state = {};
  await processor.processInputStep!({ messageList: list, state } as any);
  await processor.processInputStep!({ messageList: list, state } as any);
  assert.deepEqual(paths, [["src", "old/a.ts", "next/a.ts"]]);
});

test("discovery fails closed, retries partial emission once, and never changes the root prefix", async () => {
  const sources = ["first", "second"].map(name => ({ path: `src/${name}/AGENTS.md`, scope: `src/${name}`, content: `${name} child instruction` }));
  const processor = createAgentsMdProcessor(() => context, async (_, emit) => { await emit(sources); });
  const list = new MessageList();
  list.addSystem({ role: "system", content: "Cube" });
  list.add({ role: "user", content: "read child" }, "input");
  list.add({ role: "assistant", content: { format: 2, parts: [{ type: "tool-invocation", toolInvocation: {
    state: "result", toolCallId: "read-child", toolName: "read_file", args: { path: "src/file.ts" }, result: "source",
  } }] } }, "response");
  const state = {};
  await assert.rejects(processor.processInputStep!({ messageList: list, state } as any) as Promise<unknown>, /native signal delivery/);
  let attempts = 0;
  const sendSignal = async (input: Parameters<typeof createSignal>[0]) => {
    if (++attempts === 2) throw new Error("Discovery delivery failed");
    const signal = createSignal(input); list.addSignal(signal); return signal;
  };
  await assert.rejects(processor.processInputStep!({ messageList: list, state, sendSignal } as any) as Promise<unknown>, /Discovery delivery failed/);
  await processor.processInputStep!({ messageList: list, state, sendSignal } as any);
  await processor.processInputStep!({ messageList: list, state, sendSignal } as any);
  assert.equal(attempts, 3);
  assert.equal(list.get.all.db().filter(message => message.role === "signal").length, 2);
  const prompt = await processor.processLLMRequest!({ prompt: await list.get.all.aiV6.llmPrompt() } as any);
  assert.equal(JSON.stringify(prompt?.prompt?.[1]), JSON.stringify({ role: "user", content: [{ type: "text", text: context }] }));
});

test("native requests inject AGENTS without persisting it", async () => {
  const requests: unknown[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      requests.push(options.prompt);
      const tool = requests.length === 1;
      return {
        content: tool
          ? [{ type: "tool-call", toolCallId: "read-1", toolName: "read_file", input: '{"path":"src/file.ts"}' }]
          : [{ type: "text", text: "done" }],
        finishReason: { unified: tool ? "tool-calls" : "stop", raw: tool ? "tool-calls" : "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const storage = new InMemoryStore();
  const memory = new Memory({ storage, options: {
    generateTitle: false, lastMessages: 100,
    observationalMemory: false,
  } });
  const agent = new Agent({
    id: "context-probe", name: "Context probe", instructions: "Cube", model, memory,
    tools: { read_file: createTool({
      id: "read_file", description: "Read the fixture", inputSchema: z.object({ path: z.string() }),
      execute: async () => "fixture source",
    }) },
    inputProcessors: [createAgentsMdProcessor(() => context)],
  });
  let prefix: any[] | undefined;
  for (const text of ["first", "second"]) {
    await agent.generate(text, { memory: { thread: "thread", resource: "workspace" } });
    const prompt = requests.at(-1) as any[];
    const matches = prompt.filter((message) => JSON.stringify(message).includes("Use pnpm."));
    assert.equal(matches.length, 1);
    const index = prompt.indexOf(matches[0]);
    assert.equal(index, prompt.findIndex((message) => message.role !== "system"));
    assert.match(JSON.stringify(prompt[index + 1]), /first/);
    if (prefix) assert.deepEqual(prompt.slice(0, index + 1), prefix);
    prefix = prompt.slice(0, index + 1);
  }
  assert.equal(requests.length, 3);
  const continuation = requests[1] as any[];
  const toolIndex = continuation.findIndex((message) => message.role === "tool");
  assert.ok(toolIndex > 0);
  assert.equal(continuation[toolIndex - 1].role, "assistant");
  const saved = await memory.recall({ threadId: "thread", resourceId: "workspace" });
  assert.doesNotMatch(JSON.stringify(saved.messages), /Use pnpm|agents_instructions/);
  assert.match(JSON.stringify(saved.messages), /first/);
  assert.match(JSON.stringify(saved.messages), /second/);
});
