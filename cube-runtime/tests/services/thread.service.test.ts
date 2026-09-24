import assert from "node:assert/strict";
import test from "node:test";
import type { Session, InstructionSnapshot } from "@cube/agent";
import { ThreadService } from "../../src/services/thread.service.js";

const asSession = (value: any): Session => {
  const metadata = new Map<string, Record<string, unknown>>();
  const set = async ({ threadId, key, value: item }: any) => {
    metadata.set(threadId, { ...metadata.get(threadId), [key]: structuredClone(item) });
  };
  value.thread.setSettingOn ??= set;
  value.thread.setSetting ??= ({ key, value: item }: any) =>
    set({ threadId: value.thread.getId(), key, value: item });
  return value as Session;
};

const instructions = (reload = async () => undefined) => {
  let snapshot: InstructionSnapshot = { soul: "Cube", sources: [], explored: [] };
  return {
    read: () => structuredClone(snapshot),
    install: (next: InstructionSnapshot) => { snapshot = structuredClone(next); },
    reload,
    refresh: async (saved: unknown) => structuredClone(saved === undefined ? snapshot : saved as InstructionSnapshot),
  };
};

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
  const service = new ThreadService(session, instructions(), () => "planned");

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
    ["getById", "thread-2"],
    ["switch", "thread-2"],
    ["getById", "thread-2"],
    ["listMessages", "thread-2"],
  ]);
  assert.equal(snapshot.threadId, "thread-2");
  assert.equal(snapshot.title, "Two");
  assert.deepEqual(snapshot.messages, messages);
});

test("ThreadService reuses startup instructions for the first lazy thread", async () => {
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
    instructions(async () => { assert.fail("unexpected startup reread"); }),
    () => "planned-1",
  );

  assert.equal(await service.ensureForPrompt("  hello   runtime  "), "planned-1");
  assert.equal(await service.ensureForPrompt("second prompt"), "planned-1");
  assert.deepEqual(calls, [
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
    instructions(async () => { calls.push("reloadInstructions"); }),
    () => ids.shift() ?? "unexpected",
  );

  await assert.rejects(service.create(), /agent turn is active/);
  assert.deepEqual(calls, []);
  running = false;
  assert.deepEqual(await service.create(), { threadId: null });
  assert.deepEqual(calls, ["detach", "release"]);
  assert.equal(await service.ensureForPrompt("next"), "planned-2");
  assert.deepEqual(calls, [
    "detach",
    "release",
    "reloadInstructions",
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
    instructions(),
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
  const service = new ThreadService(session, instructions(), () => "planned");

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
  const service = new ThreadService(session, instructions(), () => "planned");

  assert.deepEqual(await service.rename("  Runtime architecture  "), {
    threadId: "thread-1",
    title: "Runtime architecture",
  });
  assert.deepEqual(calls, [["rename", "Runtime architecture"]]);
  await assert.rejects(service.rename("   "), /Thread title is required/);
});

test("explicit reload includes discovered scopes, persists metadata and rejects active turns", async () => {
  let running = true;
  const saved: unknown[] = [];
  const binding = instructions();
  const reloads: (boolean | undefined)[] = [];
  const session = asSession({
    run: { isRunning: () => running },
    thread: {
      getId: () => "thread-1",
      setSetting: async (setting: unknown) => { saved.push(setting); },
    },
  });
  const service = new ThreadService(session, {
    ...binding,
    reload: async (includeDiscovered) => {
      reloads.push(includeDiscovered);
      binding.install({ soul: "reloaded", sources: [], explored: ["src"] });
    },
  });
  await assert.rejects(service.reload(), /agent turn is active/);
  assert.deepEqual(reloads, []);
  running = false;
  await service.reload();
  assert.deepEqual(reloads, [true]);
  assert.deepEqual(saved, [{ key: "cubeInstructions", value: binding.read() }]);
});

test("thread snapshots isolate resume/fork, refresh on restart, and retry a failed new-thread load", async () => {
  let active: string | null = null;
  let nextId = 0;
  let reloads = 0;
  let refreshes = 0;
  let failReload = false;
  const stored = new Map<string, { id: string; title: string; metadata: Record<string, unknown> }>();
  const binding = instructions();
  binding.reload = async () => {
    reloads++;
    if (failReload) throw new Error("EACCES instructions");
    binding.install({ soul: "fresh", sources: [], explored: [] });
  };
  binding.refresh = async (saved) => {
    refreshes++;
    return { ...structuredClone(saved as InstructionSnapshot), soul: "restarted" };
  };
  const setSettingOn = async ({ threadId, key, value }: any) => {
    stored.get(threadId)!.metadata[key] = structuredClone(value);
  };
  const session = asSession({
    run: { isRunning: () => false },
    thread: {
      getId: () => active,
      create: async ({ id, title }: any) => {
        const row = { id, title, metadata: {} };
        stored.set(id, row); active = id; return row;
      },
      getById: async ({ threadId }: any) => structuredClone(stored.get(threadId)),
      listMessages: async () => [],
      detachFromCurrent: () => {},
      clearAndReleaseLock: async () => { active = null; },
      switch: async ({ threadId }: any) => { active = threadId; },
      clone: async ({ sourceThreadId }: any) => {
        const row = structuredClone(stored.get(sourceThreadId)!);
        row.id = "fork"; stored.set(row.id, row); active = row.id; return row;
      },
      setSettingOn,
      setSetting: ({ key, value }: any) => setSettingOn({ threadId: active, key, value }),
    },
  });
  const service = new ThreadService(session, binding, () => `thread-${++nextId}`);
  await service.ensureForPrompt("first");
  const scoped = { soul: "Cube", sources: [{ path: "a/AGENTS.md", scope: "a", content: "A" }], explored: ["a"] };
  await service.saveInstructions(scoped); binding.install(scoped);
  await service.fork();
  const changed = binding.read(); changed.sources[0]!.content = "fork only";
  await service.saveInstructions(changed); binding.install(changed);
  await service.resume("thread-1");
  assert.equal(binding.read().sources[0]?.content, "A");
  assert.equal(refreshes, 0);
  assert.equal(reloads, 0);
  await service.create();
  assert.equal(reloads, 0);
  failReload = true;
  await assert.rejects(service.ensureForPrompt("next"), /EACCES/);
  assert.equal(active, null);
  assert.equal(binding.read().sources[0]?.content, "A");
  failReload = false;
  await service.ensureForPrompt("next");
  assert.deepEqual(binding.read().sources, []);
  await service.resume("fork");
  assert.equal(binding.read().sources[0]?.content, "fork only");
  assert.equal(refreshes, 0);
  const restarted = new ThreadService(session, binding);
  await restarted.resume("thread-1");
  assert.equal(refreshes, 1);
  assert.equal(binding.read().soul, "restarted");
  await restarted.resume("thread-1");
  assert.equal(refreshes, 1);
});
