import assert from "node:assert/strict";
import test from "node:test";
import { INITIALIZE_PROMPT, type Session } from "@cube/agent";
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
    { gateway: { readiness: async () => ({ ready: true }) } } as unknown as SlashCommandContext,
    async (callback) => callback(),
    async (text, threadId) => {
      history.push({ text, threadId });
    },
  );

  assert.deepEqual(await service.submit("  hello  "), { kind: "submitted" });
  assert.deepEqual(await service.submit("/exit"), { kind: "exit-requested" });
  assert.deepEqual(await service.submit("/tasks"), { kind: "tasks" });
  assert.ok(slashCommandSuggestions.some(command => command.name === "/tasks"));
  assert.equal(followUpCalls, 1);
  assert.deepEqual(calls, [
    ["ensureForPrompt", "hello"],
    ["followUp", "hello"],
  ]);
  assert.deepEqual(history, [
    { text: "hello", threadId: "thread-1" },
    { text: "/exit", threadId: "thread-1" },
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
    { gateway: { readiness: async () => ({ ready: true }) } } as unknown as SlashCommandContext,
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

test("/init dispatches without echo, records history once, and requires an idle configured session", async () => {
  const history: string[] = [];
  const sent: unknown[] = [];
  let echoes = 0;
  let created = 0;
  let ready = true;
  let busy = false;
  let listener: ((event: { type: string }) => void) | undefined;
  let unsubscribed = 0;
  let fail = false;
  const finalized: string[] = [];
  const session = {
    run: { isRunning: () => busy },
    approval: { isArmed: () => false },
    suspensions: { hasPending: () => false },
    followUp: async () => { assert.fail("/init must not enter the follow-up queue"); },
    subscribe: (callback: typeof listener) => {
      listener = callback;
      return () => { listener = undefined; unsubscribed++; };
    },
    sendSignal: (signal: unknown, options: unknown) => {
      sent.push(signal);
      assert.deepEqual(options, { requireDelivery: true });
      return { accepted: fail ? Promise.reject(new Error("init delivery failed")) : Promise.resolve({ accepted: true }) };
    },
  } as unknown as Session;
  const commands = {
    gateway: { readiness: async () => ({ ready }), listChoices: () => [] },
    memory: { isBusy: () => false },
    prompt: { initialize: () => service.initialize() },
  } as unknown as SlashCommandContext;
  const service = new PromptService(
    {} as Home, session,
    { current: () => null, ensureForPrompt: async () => { created++; return "init-thread"; },
      finishRun: async (reason: string) => { finalized.push(reason); },
    } as unknown as ThreadService,
    commands, (callback) => callback(), async (text) => { history.push(text); },
  );
  assert.ok(slashCommandSuggestions.some((command) => command.name === "/init"));
  let completed = false;
  const init = service.submit("/init", () => { echoes++; }).then(result => { completed = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, "signal acceptance is not turn completion");
  listener!({ type: "agent_end" });
  assert.deepEqual(await init, { kind: "submitted" });
  assert.deepEqual(history, ["/init"]);
  assert.deepEqual(sent, [{ type: "user", tagName: "user", contents: INITIALIZE_PROMPT, metadata: { cube: { displayText: "" } } }]);
  assert.equal(unsubscribed, 1);
  assert.equal(echoes, 0);
  assert.equal(created, 1);
  ready = false;
  assert.deepEqual(await service.submit("/init"), { kind: "gateways", request: { choices: [] } });
  assert.equal(created, 1);
  ready = true;
  busy = true;
  const blocked = await service.submit("/init");
  assert.equal(blocked.kind, "notice");
  assert.equal(sent.length, 1);
  busy = false;
  fail = true;
  const rejected = await service.submit("/init");
  assert.equal(rejected.kind, "notice");
  assert.match(JSON.stringify(rejected), /init delivery failed/);
  assert.deepEqual(finalized, ["error"]);
  assert.equal(unsubscribed, 2);
});

test("MCP changes block prompts before thread creation but keep /mcp view available", async () => {
  let applying = true;
  let readinessCalls = 0, created = 0, sent = 0;
  const thread = { current: () => null, ensureForPrompt: async () => { created++; applying = true; return "thread"; } } as unknown as ThreadService;
  const service = new PromptService({} as Home, {
    followUp: async () => { sent++; }, run: { isRunning: () => false },
  } as unknown as Session, thread, {
    mcp: { isApplying: () => applying },
    gateway: { readiness: async () => { readinessCalls++; return { ready: true }; } },
  } as unknown as SlashCommandContext, callback => callback(), async () => undefined);
  assert.equal((await service.submit("hello")).kind, "notice");
  assert.equal(readinessCalls, 0);
  assert.equal(created, 0);
  assert.deepEqual(await service.submit("/mcp"), { kind: "mcp" });
  applying = false;
  assert.equal((await service.submit("hello")).kind, "notice");
  assert.equal(created, 1);
  assert.equal(sent, 0);
});

test("PromptService converts provider failures into one safe system notice", async () => {
  const finalized: string[] = [];
  const session = {
    followUp: async () => {
      throw new Error("HTTP 429 request rejected: Bearer leaked-secret");
    },
    followUps: { dequeue: () => undefined, count: () => 0 },
  } as unknown as Session;
  const service = new PromptService(
    {} as Home,
    session,
    {
      current: () => "thread-1",
      ensureForPrompt: async () => "thread-1",
      finishRun: async (reason: string) => { finalized.push(reason); },
    } as unknown as ThreadService,
    { gateway: { readiness: async () => ({ ready: true }) } } as unknown as SlashCommandContext,
    (callback) => callback(),
    async () => undefined,
  );

  assert.deepEqual(await service.submit("hello"), {
    kind: "notice",
    notice: {
      level: "error",
      message: "HTTP 429 request rejected: Bearer [Redacted]",
    },
  });
  assert.deepEqual(finalized, ["error"]);
});

test("PromptService keeps third-party warnings out of the terminal console", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  const session = {
    followUp: async () => {
      console.warn("raw provider warning");
    },
    followUps: { dequeue: () => undefined, count: () => 0 },
  } as unknown as Session;
  const service = new PromptService(
    {} as Home,
    session,
    {
      current: () => "thread-1",
      ensureForPrompt: async () => "thread-1",
    } as unknown as ThreadService,
    { gateway: { readiness: async () => ({ ready: true }) } } as unknown as SlashCommandContext,
    (callback) => callback(),
    async () => undefined,
  );

  try {
    assert.deepEqual(await service.submit("hello"), { kind: "submitted" });
    assert.deepEqual(warnings, []);
    console.warn("after");
    assert.deepEqual(warnings, [["after"]]);
  } finally {
    console.warn = originalWarn;
  }
});
