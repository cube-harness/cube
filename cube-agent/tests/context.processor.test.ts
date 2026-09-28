import assert from "node:assert/strict";
import test from "node:test";
import { Agent, MessageList, type MastraDBMessage } from "@mastra/core/agent";
import { AgentController } from "@mastra/core/agent-controller";
import { Mastra } from "@mastra/core";
import { InMemoryStore } from "@mastra/core/storage";
import { Memory } from "@mastra/memory";
import { createTool } from "@mastra/core/tools";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { RequestContext } from "@mastra/core/request-context";
import { makeRequestFrame, createContextProcessor } from "../src/processors/context.processor.js";
import { CubeContext } from "../src/context.js";
import { createAgentsMdProcessor } from "../src/processors/agents-md.processor.js";

test("projection keeps repeated users, native tools, protected instructions and raw media intact", async () => {
  const messages: MastraDBMessage[] = [
    { id: "u1", role: "user", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "same" }] } },
    { id: "a1", role: "assistant", createdAt: new Date(), content: { format: 2, parts: [{ type: "tool-invocation", toolInvocation: {
      state: "result", toolCallId: "t1", toolName: "read_file", args: { path: "file.pdf" }, result: { type: "file", data: "BASE64" },
    } }] } },
    { id: "u2", role: "user", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "same" }] } },
  ];
  const original = structuredClone(messages);
  const list = new MessageList();
  list.add(messages, "memory");
  const prompt = await list.get.all.aiV5.llmPrompt();
  prompt.unshift({ role: "system", content: "SOUL" });
  const project = { role: "user" as const, content: [{ type: "text" as const, text: "<project_context>AGENTS</project_context>" }] };
  prompt.splice(prompt.length - 1, 0, project);
  const frame = makeRequestFrame({
    threadId: "thread", messages, prompt, protectedMessages: new WeakSet([project]), toolsTokens: 10,
    requestContext: new RequestContext(), limits: { context: 256_000 }, isCurrent: () => true,
  });
  const pruned = frame.project({ prunedToolCallIds: ["t1"] });
  assert.doesNotMatch(JSON.stringify(pruned), /BASE64/);
  assert.match(JSON.stringify(pruned), /Old tool output omitted/);
  assert.match(JSON.stringify(pruned), /tool-call/);
  const compacted = frame.project({ summary: { text: "completed", firstRetainedMessageId: "u2" }, prunedToolCallIds: [] });
  assert.equal(compacted.length, 4);
  assert.equal(compacted[0]?.role, "system");
  assert.match(JSON.stringify(compacted[1]), /<summary>/);
  assert.equal(compacted[2], project);
  assert.deepEqual(messages, original);
  assert.equal(frame.count(compacted)! > 10, true);
});

test("a formerly pinned task is folded into the next summary, not lost", async () => {
  const messages: MastraDBMessage[] = [
    { id: "u1", role: "user", createdAt: new Date(1), content: { format: 2, parts: [{ type: "text", text: "Original task: never delete user files" }] } },
    { id: "a1", role: "assistant", createdAt: new Date(2), content: { format: 2, parts: [{ type: "text", text: "work".repeat(2000) }] } },
    { id: "u2", role: "user", createdAt: new Date(3), content: { format: 2, parts: [{ type: "text", text: "continue" }] } },
    { id: "a2", role: "assistant", createdAt: new Date(4), content: { format: 2, parts: [{ type: "text", text: "recent" }] } },
  ];
  const list = new MessageList();
  list.add(messages, "memory");
  const frame = makeRequestFrame({ threadId: "t", messages, prompt: await list.get.all.aiV5.llmPrompt(),
    protectedMessages: new WeakSet(), toolsTokens: 0, limits: { context: 256_000 },
    requestContext: new RequestContext(), isCurrent: () => true });
  const selection = frame.select({ prunedToolCallIds: [], summary: {
    text: "Prior work", firstRetainedMessageId: "a1", taskMessageId: "u1",
  } }, 1)!;
  assert.equal(selection.task, "u2");
  assert.match(selection.text, /never delete user files/);
  assert.doesNotMatch(selection.text, /Prior work/);
});

test("native Session compacts repeated tool continuations and can compact manually after completion", { timeout: 30_000 }, async () => {
  const storage = new InMemoryStore();
  const requests: unknown[] = [];
  let summaries = 0;
  const context = new CubeContext({
    policy: { manual_min_ratio: 0.3, keep_recent_ratio: 0.25, reserve_tokens: 16_384 },
    storage: async () => (await storage.getStore("memory"))!, protectedTools: new Set(["skill"]),
    summarize: async ({ text }) => {
      summaries++;
      if (summaries === 1) {
        assert.match(text, /older task/);
        assert.doesNotMatch(text, /<previous-summary>/);
      } else {
        assert.match(text, /<previous-summary>\nCompleted older task\. Continue the latest request\.\n<\/previous-summary>/);
      }
      return { text: "Completed older task. Continue the latest request.", finishReason: "stop" };
    },
  });
  const model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
    const first = requests.length < 4;
    requests.push(prompt);
    const content = first ? [{ type: "tool-call", toolName: "read_file", toolCallId: `new-call-${requests.length}`, input: "{}" }]
      : [{ type: "text-start", id: "answer" }, { type: "text-delta", id: "answer", delta: "done" }, { type: "text-end", id: "answer" }];
    return { stream: new ReadableStream({ start(controller) {
      for (const chunk of [{ type: "stream-start", warnings: [] }, ...content, {
        type: "finish", finishReason: { unified: first ? "tool-calls" : "stop", raw: "stop" },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      }]) controller.enqueue(chunk);
      controller.close();
    } }) };
  } });
  const agent = new Agent({ id: "context-agent", name: "Context", instructions: "SOUL", model,
    tools: { read_file: createTool({ id: "read_file", description: "Read", inputSchema: z.object({}), execute: async () => "b".repeat(90_000) }) },
    inputProcessors: [
      createAgentsMdProcessor(() => "<project_context>Use pnpm</project_context>", undefined, (m) => context.protectedMessages.add(m)),
      // The next request uses the smaller active-model window, not the first envelope.
      createContextProcessor(context, async () => ({ limits: { context: requests.length ? 65_000 : 256_000 } }), () => "snapshot"),
    ],
  });
  const controller = new AgentController({ id: "context-controller", agent,
    memory: new Memory({ options: { generateTitle: false, observationalMemory: false, lastMessages: Number.MAX_SAFE_INTEGER } }),
    modes: [{ id: "default", name: "Default", metadata: { default: true } }],
  });
  const mastra = new Mastra({ storage, agentControllers: { controller }, logger: false });
  const session = await controller.createSession({ resourceId: "workspace" });
  const errors: unknown[] = [];
  session.subscribe((event) => { if (event.type === "error") errors.push(event); });
  try {
    await session.permissions.setForTool({ toolName: "read_file", policy: "allow" });
    await session.thread.create({ id: "native-context" });
    const store = (await storage.getStore("memory"))!;
    await store.saveMessages({ messages: [
      { id: "older-user", role: "user", threadId: "native-context", resourceId: "workspace", createdAt: new Date(1), content: { format: 2, parts: [{ type: "text", text: "older task" }] } },
      { id: "older-response", role: "assistant", threadId: "native-context", resourceId: "workspace", createdAt: new Date(2), content: { format: 2, parts: [{ type: "text", text: "a".repeat(120_000) }] } },
    ] });
    await session.followUp({ content: "current task" });
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 5);
    assert.equal(summaries, 2);
    assert.doesNotMatch(JSON.stringify(requests[0]), /<summary>/);
    assert.match(JSON.stringify(requests[1]), /<summary>/);
    assert.match(JSON.stringify(requests[1]), /current task/);
    assert.match(JSON.stringify(requests[1]), /Use pnpm/);
    assert.match(JSON.stringify(await session.thread.listMessages({ threadId: "native-context" })), /a{120000}/);
    const manual = await context.compactManual({ threadId: "native-context", signal: new AbortController().signal });
    assert.equal(manual.status, "compacted");
    assert.equal(summaries, 3);
  } finally {
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
    await mastra.shutdown();
  }
});
