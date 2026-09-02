import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "@cube/agent";
import { ThreadService } from "../../src/services/thread.service.js";

const asSession = (value: unknown): Session => value as Session;

test("ThreadService lists active state and resumes with one switch and one snapshot read", async () => {
  const calls: unknown[][] = [];
  let activeId: string | null = "thread-1";
  const messages = [
    { id: "message-1", role: "user", content: "hello" },
    { id: "message-2", role: "assistant", content: "hi" },
  ];
  const session = asSession({
    run: { isRunning: () => false },
    thread: {
      getId: () => activeId,
      list: async () => [
        {
          id: "thread-1",
          title: "One",
          updatedAt: new Date("2026-08-28T10:00:00.000Z"),
        },
        {
          id: "thread-2",
          title: "Two",
          updatedAt: new Date("2026-08-28T11:00:00.000Z"),
        },
      ],
      switch: async ({ threadId }: { threadId: string }) => {
        calls.push(["switch", threadId]);
        activeId = threadId;
      },
      getById: async ({ threadId }: { threadId: string }) => {
        calls.push(["getById", threadId]);
        return { id: threadId, title: "Two" };
      },
      listMessages: async ({ threadId }: { threadId: string }) => {
        calls.push(["listMessages", threadId]);
        return messages;
      },
    },
  });
  const service = new ThreadService(session, async () => undefined, () => "planned");

  assert.deepEqual(await service.list(), [
    {
      id: "thread-1",
      title: "One",
      updatedAt: "2026-08-28T10:00:00.000Z",
      isActive: true,
    },
    {
      id: "thread-2",
      title: "Two",
      updatedAt: "2026-08-28T11:00:00.000Z",
      isActive: false,
    },
  ]);

  const snapshot = await service.resume("thread-2");
  assert.deepEqual(calls, [
    ["switch", "thread-2"],
    ["getById", "thread-2"],
    ["listMessages", "thread-2"],
  ]);
  assert.equal(snapshot.threadId, "thread-2");
  assert.equal(snapshot.title, "Two");
  assert.deepEqual(snapshot.messages, messages);
});

test("ThreadService lazily creates one thread after reloading SOUL and reuses it", async () => {
  const calls: unknown[][] = [];
  let activeId: string | null = null;
  const session = asSession({
    run: { isRunning: () => false },
    thread: {
      getId: () => activeId,
      create: async ({ id, title }: { id: string; title: string }) => {
        calls.push(["create", id, title]);
        activeId = id;
        return { id, title };
      },
    },
  });
  const service = new ThreadService(
    session,
    async () => {
      calls.push(["reloadSoul"]);
    },
    () => "planned-1",
  );

  assert.equal(await service.ensureForPrompt("  hello   runtime  "), "planned-1");
  assert.equal(await service.ensureForPrompt("second prompt"), "planned-1");
  assert.deepEqual(calls, [
    ["reloadSoul"],
    ["create", "planned-1", "hello runtime"],
  ]);
});

test("ThreadService creates a fresh unbound state and rotates its planned id", async () => {
  const calls: string[] = [];
  let running = true;
  let activeId: string | null = "thread-1";
  const ids = ["planned-1", "planned-2"];
  const session = asSession({
    run: { isRunning: () => running },
    thread: {
      getId: () => activeId,
      detachFromCurrent: () => calls.push("detach"),
      clearAndReleaseLock: async () => {
        calls.push("release");
        activeId = null;
      },
      create: async ({ id }: { id: string }) => {
        calls.push(`create:${id}`);
        activeId = id;
        return { id };
      },
    },
  });
  const service = new ThreadService(
    session,
    async () => {
      calls.push("reloadSoul");
    },
    () => ids.shift() ?? "unexpected",
  );

  await assert.rejects(service.create(), /agent turn is active/);
  assert.deepEqual(calls, []);
  running = false;
  assert.deepEqual(await service.create(), { threadId: null });
  assert.deepEqual(calls, ["reloadSoul", "detach", "release"]);
  assert.equal(await service.ensureForPrompt("next"), "planned-2");
  assert.deepEqual(calls, [
    "reloadSoul",
    "detach",
    "release",
    "reloadSoul",
    "create:planned-2",
  ]);
});

test("ThreadService deletes an active thread and forks without a redundant switch", async () => {
  const calls: unknown[][] = [];
  let activeId: string | null = "thread-1";
  const messages = [{ id: "message-1", role: "assistant", content: "forked" }];
  const session = asSession({
    run: { isRunning: () => false },
    thread: {
      getId: () => activeId,
      delete: async ({ threadId }: { threadId: string }) => {
        calls.push(["delete", threadId]);
        if (threadId === activeId) activeId = null;
      },
      clone: async ({ sourceThreadId, title }: { sourceThreadId: string; title?: string }) => {
        calls.push(["clone", sourceThreadId, title]);
        activeId = "thread-fork";
        return { id: "thread-fork", title: title ?? "Fork" };
      },
      switch: async ({ threadId }: { threadId: string }) => {
        calls.push(["switch", threadId]);
      },
      getById: async ({ threadId }: { threadId: string }) => {
        calls.push(["getById", threadId]);
        return { id: threadId, title: "Fork title" };
      },
      listMessages: async ({ threadId }: { threadId: string }) => {
        calls.push(["listMessages", threadId]);
        return messages;
      },
    },
  });
  const ids = ["planned-1", "planned-2"];
  const service = new ThreadService(
    session,
    async () => undefined,
    () => ids.shift() ?? "unexpected",
  );

  assert.deepEqual(await service.delete("thread-1"), {
    threadId: "thread-1",
    wasActive: true,
  });
  activeId = "thread-2";
  assert.deepEqual(await service.fork("  Fork title  "), {
    threadId: "thread-fork",
    title: "Fork title",
    messages,
  });
  assert.deepEqual(calls, [
    ["delete", "thread-1"],
    ["clone", "thread-2", "Fork title"],
    ["getById", "thread-fork"],
    ["listMessages", "thread-fork"],
  ]);
});

test("ThreadService returns only text from the latest assistant response", async () => {
  const messages = [
    { role: "assistant", content: "older response" },
    {
      role: "assistant",
      content: {
        parts: [
          { type: "tool-call", toolName: "execute", args: {} },
          { type: "text", text: " first paragraph " },
          { type: "tool-result", result: "secret tool output" },
          { type: "text", text: "second paragraph" },
        ],
      },
    },
  ];
  const session = asSession({
    run: { isRunning: () => false },
    thread: {
      getId: () => "thread-1",
      listMessages: async () => messages,
    },
  });
  const service = new ThreadService(session, async () => undefined, () => "planned");

  assert.equal(
    await service.lastAssistantContent(),
    "first paragraph\n\nsecond paragraph",
  );
});

test("ThreadService validates and renames the active native thread", async () => {
  const calls: unknown[][] = [];
  const session = asSession({
    run: { isRunning: () => false },
    thread: {
      getId: () => "thread-1",
      rename: async ({ title }: { title: string }) => {
        calls.push(["rename", title]);
      },
    },
  });
  const service = new ThreadService(session, async () => undefined, () => "planned");

  assert.deepEqual(await service.rename("  Runtime architecture  "), {
    threadId: "thread-1",
    title: "Runtime architecture",
  });
  assert.deepEqual(calls, [["rename", "Runtime architecture"]]);
  await assert.rejects(service.rename("   "), /Thread title is required/);
});
