import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, MessageList, createSignal } from "@mastra/core/agent";
import { AgentController } from "@mastra/core/agent-controller";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { createTool } from "@mastra/core/tools";
import { RequestContext } from "@mastra/core/request-context";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  createEnvironmentProcessor,
  isEnvironmentContext,
  readEnvironmentTime,
} from "../src/processors/environment.processor.js";
import { makeRequestFrame } from "../src/processors/context.processor.js";

test("environment date uses the host timezone rather than the UTC calendar date", () => {
  const now = new Date("2026-10-13T00:30:00Z");
  assert.deepEqual(readEnvironmentTime(now, "UTC"), { date: "2026-10-13", timezone: "UTC" });
  assert.deepEqual(readEnvironmentTime(now, "America/New_York"), {
    date: "2026-10-12", timezone: "America/New_York",
  });
  assert.equal(readEnvironmentTime(new Date("2026-10-12T18:30:00Z"), "Asia/Ho_Chi_Minh").date, "2026-10-13");
});

test("native environment signals keep the request prefix, freeze tool steps and survive SQLite resume/fork", { timeout: 30_000 }, async () => {
  let time = { date: "2026-10-13", timezone: "Asia/Ho_Chi_Minh" };
  const requests: any[][] = [];
  const model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
    const toolCall = requests.length === 0;
    requests.push(prompt);
    return { stream: new ReadableStream({ start(stream) {
      const output = toolCall
        ? [{ type: "tool-call", toolCallId: "read", toolName: "read_file", input: "{}" }]
        : [{ type: "text-start", id: "answer" }, { type: "text-delta", id: "answer", delta: "done" }, { type: "text-end", id: "answer" }];
      for (const chunk of [
        { type: "stream-start", warnings: [] }, ...output,
        { type: "finish", finishReason: { unified: toolCall ? "tool-calls" : "stop", raw: toolCall ? "tool_calls" : "stop" }, usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        } },
      ]) stream.enqueue(chunk);
      stream.close();
    } }) };
  } });
  // cloneThread uses a native transaction; use a real SQLite file, as Cube does.
  const root = await mkdtemp(join(tmpdir(), "cube-environment-"));
  const storage = new LibSQLStore({ id: "environment-test", url: `file:${join(root, "memory.db")}` });
  const agent = new Agent({
    id: "environment-agent", name: "Environment agent", instructions: "Stable instructions", model,
    inputProcessors: [createEnvironmentProcessor(() => ({ ...time }))],
    tools: { read_file: createTool({ id: "read_file", description: "Read a fixture", inputSchema: z.object({}), execute: async () => {
      time = { ...time, date: "2026-10-14" };
      return "source";
    } }) },
  });
  const controller = new AgentController({
    id: "environment-controller", agent,
    memory: new Memory({ options: { generateTitle: false, lastMessages: 100 } }),
    modes: [{ id: "default", name: "Default", metadata: { default: true } }],
  });
  const mastra = new Mastra({ storage, agentControllers: { controller }, logger: false });
  const session = await controller.createSession({ resourceId: "project" });
  const errors: unknown[] = [];
  session.subscribe(event => { if (event.type === "error") errors.push(event.error); });
  try {
    await session.permissions.setForTool({ toolName: "read_file", policy: "allow" });
    await session.thread.create({ id: "environment-thread" });
    await session.followUp({ content: "first request" });
    assert.equal(requests.length, 2);
    for (const prompt of requests) {
      const text = prompt.flatMap(message => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "text").map((part: any) => part.text) : [message.content]).join("\n");
      assert.equal((text.match(/<environment_context\b/g) ?? []).length, 1, text);
      assert.match(text, /current_date="2026-10-13"/);
      assert.doesNotMatch(JSON.stringify(prompt), /2026-10-14/);
    }
    time = { ...time, date: "2026-10-13" };
    await session.followUp({ content: "same day" });
    // Mastra refreshes non-text createdAt provider metadata on restored rows.
    // The model-facing roles and content, rather than that bookkeeping, form the prefix.
    const rendered = (prompt: any[]) => JSON.stringify(prompt, (key, value) => key === "providerOptions" ? undefined : value);
    assert.equal(rendered(requests.at(-1)!.slice(0, requests[0]!.length)), rendered(requests[0]!));
    const first = (await session.thread.listMessages({ threadId: "environment-thread" })).filter(isEnvironmentContext);
    assert.equal(first.length, 1);
    time = { ...time, date: "2026-10-14" };
    await session.followUp({ content: "next day" });
    const messages = await session.thread.listMessages({ threadId: "environment-thread" });
    assert.equal(messages.filter(isEnvironmentContext).length, 2);
    assert.deepEqual(messages.find(message => message.id === first[0]!.id)?.content, first[0]!.content);
    const memory = (await storage.getStore("memory"))!;
    const restored = await memory.listMessages({ threadId: "environment-thread", perPage: false });
    assert.equal(restored.messages.filter(isEnvironmentContext).length, 2);
    await memory.cloneThread({ sourceThreadId: "environment-thread", newThreadId: "environment-fork" });
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
    await session.thread.switch({ threadId: "environment-fork" });
    await session.followUp({ content: "continue fork" });
    assert.equal((await session.thread.listMessages({ threadId: "environment-fork" })).filter(isEnvironmentContext).length, 2);
    time = { ...time, timezone: "UTC" };
    await session.followUp({ content: "timezone changed" });
    assert.equal((await session.thread.listMessages({ threadId: "environment-fork" })).filter(isEnvironmentContext).length, 3);
    assert.deepEqual(errors, []);
  } finally {
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
    await mastra.shutdown();
    await storage.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("compaction keeps the latest environment marker outside the retained history boundary", async () => {
  const list = new MessageList();
  list.addSignal(createSignal({ type: "reactive", tagName: "environment_context", metadata: { cube: { kind: "environment-context" } }, attributes: { current_date: "2026-10-12", timezone: "UTC" }, contents: "Host-local date" }));
  list.addSignal(createSignal({ type: "reactive", tagName: "environment_context", metadata: { cube: { kind: "environment-context" } }, attributes: { current_date: "2026-10-13", timezone: "UTC" }, contents: "Host-local date" }));
  list.add({ id: "current-user", role: "user", content: "continue" }, "input");
  const messages = list.get.all.db();
  const frame = makeRequestFrame({
    threadId: "thread", messages, prompt: await list.get.all.aiV5.llmPrompt(),
    protectedMessages: new WeakSet(), toolsTokens: 0, limits: { context: 256_000 },
    requestContext: new RequestContext(), isCurrent: () => true,
  });
  const prompt = frame.project({ summary: { text: "Earlier work", firstRetainedMessageId: "current-user" }, prunedToolCallIds: [] });
  assert.match(JSON.stringify(prompt), /2026-10-13/);
  assert.doesNotMatch(JSON.stringify(prompt), /2026-10-12/);
  assert.match(JSON.stringify(prompt), /continue/);
  assert.match(JSON.stringify(prompt), /Earlier work/);
  assert.equal((JSON.stringify(prompt).match(/<environment_context\b/g) ?? []).length, 1);
});
