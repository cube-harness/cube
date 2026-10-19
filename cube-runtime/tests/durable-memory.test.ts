import assert from "node:assert/strict";
import test from "node:test";
import type { Session, InstructionSnapshot } from "@cube/agent";
import { ThreadService } from "../src/services/thread.service.js";

test("lifecycle checks occur only on real creation/activation, never new or each prompt", async () => {
  let active: string | null = null;
  const activated: string[] = [];
  const snapshot: InstructionSnapshot = { soul: "Cube", sources: [], explored: [], durableMemory: null };
  const session = { run: { isRunning: () => false }, thread: {
    getId: () => active,
    create: async ({ id }: { id: string }) => { active = id; return { id }; },
    switch: async ({ threadId }: { threadId: string }) => { active = threadId; },
    getById: async ({ threadId }: { threadId: string }) => ({ id: threadId, metadata: {} }),
    setSetting: async () => undefined, setSettingOn: async () => undefined,
    listMessages: async () => [], detachFromCurrent: () => { active = null; }, clearAndReleaseLock: async () => undefined,
  } } as unknown as Session;
  const thread = new ThreadService(session, { read: () => snapshot, install: () => undefined,
    reload: async () => undefined, refresh: async () => snapshot }, () => "new-thread", {
    fork: async () => ({ id: "fork" }), invalidate: () => undefined, isBusy: () => false,
    onActivated: id => { activated.push(id); },
  });
  await thread.create();
  assert.deepEqual(activated, []);
  await thread.ensureForPrompt("first");
  await thread.ensureForPrompt("second");
  assert.deepEqual(activated, ["new-thread"]);
  await thread.resume("previous");
  await thread.fork();
  assert.deepEqual(activated, ["new-thread", "previous", "fork"]);
});
