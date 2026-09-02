import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "@cube/agent";
import type { Home } from "@cube/workspace";
import { slashCommandSuggestions } from "../../src/slash-commands.js";
import { PromptService } from "../../src/services/prompt.service.js";
import type { SlashCommandContext } from "../../src/slash-commands.js";
import type { ThreadService } from "../../src/services/thread.service.js";

test("PromptService records input once and uses native followUp only for prompts", async () => {
  const history: Array<{ text: string; threadId: string }> = [];
  const calls: unknown[][] = [];
  let followUpCalls = 0;
  const thread = {
    current: () => "thread-1",
    ensureForPrompt: async (content: string) => {
      calls.push(["ensureForPrompt", content]);
      return "thread-1";
    },
  } as unknown as ThreadService;
  const session = {
    followUp: async ({ content }: { content: string }) => {
      calls.push(["followUp", content]);
      followUpCalls += 1;
    },
    sendMessage: async () => {
      throw new Error("PromptService bypassed the native follow-up queue");
    },
    followUps: { dequeue: () => undefined, count: () => 0 },
    emit: () => undefined,
  } as unknown as Session;
  const service = new PromptService(
    {} as Home,
    session,
    thread,
    {} as SlashCommandContext,
    async (callback) => callback(),
    async (text, threadId) => {
      history.push({ text, threadId });
    },
  );

  assert.deepEqual(await service.submit("  hello  "), { kind: "submitted" });
  assert.deepEqual(await service.submit("/help"), {
    kind: "command-catalog",
    commands: slashCommandSuggestions,
  });
  assert.equal(followUpCalls, 1);
  assert.deepEqual(calls, [
    ["ensureForPrompt", "hello"],
    ["followUp", "hello"],
  ]);
  assert.deepEqual(history, [
    { text: "hello", threadId: "thread-1" },
    { text: "/help", threadId: "thread-1" },
  ]);
});

test("PromptService cancels native follow-ups newest first without changing FIFO execution", () => {
  const queue = [
    { content: "first", requestContext: { id: 1 } },
    { content: "second", requestContext: { id: 2 } },
    { content: "third", requestContext: { id: 3 } },
  ];
  const events: unknown[] = [];
  const session = {
    followUps: {
      dequeue: () => queue.shift(),
      requeue: (followUp: (typeof queue)[number]) => queue.unshift(followUp),
      count: () => queue.length,
    },
    emit: (event: unknown) => events.push(event),
  } as unknown as Session;
  const service = new PromptService(
    {} as Home,
    session,
    { current: () => null } as unknown as ThreadService,
    {} as SlashCommandContext,
    (callback) => callback(),
    async () => undefined,
  );

  assert.equal(service.cancelLatestQueued(), "third");
  assert.deepEqual(queue.map((item) => item.content), ["first", "second"]);
  assert.equal(service.cancelLatestQueued(), "second");
  assert.deepEqual(queue.map((item) => item.content), ["first"]);
  assert.equal(service.cancelLatestQueued(), "first");
  assert.equal(service.cancelLatestQueued(), null);
  assert.deepEqual(events, [
    { type: "follow_up_queued", count: 2 },
    { type: "follow_up_queued", count: 1 },
    { type: "follow_up_queued", count: 0 },
  ]);
});
