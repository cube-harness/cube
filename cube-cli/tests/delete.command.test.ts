import assert from "node:assert/strict";
import test from "node:test";
import { createDeleteCommandHandler } from "../src/commands/delete.command.js";

test("DeleteCommand blocks execution when agent turn is active", async () => {
  let message = "";
  const handler = createDeleteCommandHandler({
    session: {} as any,
    getApp: () => undefined,
    showMessage: (msg) => {
      message = msg;
    },
    isTurnActive: () => true,
  });

  await handler("");
  assert.ok(message.includes("Cannot delete thread while an agent turn is active"));
});

test("DeleteCommand deletes specified threadId directly", async () => {
  let message = "";
  let deletedId = "";
  const handler = createDeleteCommandHandler({
    session: {
      thread: {
        getId: () => "active-thread-1",
        delete: async ({ threadId }: { threadId: string }) => {
          deletedId = threadId;
        },
      },
    } as any,
    getApp: () => ({} as any),
    showMessage: (msg) => {
      message = msg;
    },
    isTurnActive: () => false,
  });

  await handler("other-thread-2");
  assert.equal(deletedId, "other-thread-2");
  assert.ok(message.includes("Deleted thread: other-thread-2"));
});

test("DeleteCommand resets active thread state when deleting current active thread", async () => {
  let message = "";
  let deletedId = "";
  let detached = false;
  let clearedMessages = false;
  let updatedInfo: any;

  const fakeApp = {
    clearMessages: () => {
      clearedMessages = true;
    },
    setInfo: (info: any) => {
      updatedInfo = info;
    },
  };

  const handler = createDeleteCommandHandler({
    session: {
      thread: {
        getId: () => "active-thread-1",
        delete: async ({ threadId }: { threadId: string }) => {
          deletedId = threadId;
        },
        detachFromCurrent: async () => {
          detached = true;
        },
      },
    } as any,
    getApp: () => fakeApp as any,
    showMessage: (msg) => {
      message = msg;
    },
    isTurnActive: () => false,
  });

  await handler("active-thread-1");
  assert.equal(deletedId, "active-thread-1");
  assert.equal(detached, true);
  assert.equal(clearedMessages, true);
  assert.equal(updatedInfo.threadId, "new thread");
  assert.ok(message.includes("Deleted active thread. Started a fresh thread session."));
});
