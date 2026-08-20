import assert from "node:assert/strict";
import test from "node:test";
import { createRenameCommandHandler } from "../src/commands/rename.command.js";

test("RenameCommand blocks execution when agent turn is active", async () => {
  let message = "";
  const handler = createRenameCommandHandler({
    session: { thread: { getId: () => "thread-1" } } as any,
    getApp: () => undefined,
    showMessage: (msg) => {
      message = msg;
    },
    isTurnActive: () => true,
  });

  await handler("New Title");
  assert.ok(message.includes("Cannot rename thread while an agent turn is active"));
});

test("RenameCommand notifies when no active thread exists", async () => {
  let message = "";
  const handler = createRenameCommandHandler({
    session: { thread: { getId: () => null } } as any,
    getApp: () => undefined,
    showMessage: (msg) => {
      message = msg;
    },
    isTurnActive: () => false,
  });

  await handler("New Title");
  assert.ok(message.includes("No active thread to rename"));
});

test("RenameCommand requires a non-empty title argument", async () => {
  let message = "";
  const handler = createRenameCommandHandler({
    session: { thread: { getId: () => "thread-1" } } as any,
    getApp: () => undefined,
    showMessage: (msg) => {
      message = msg;
    },
    isTurnActive: () => false,
  });

  await handler("   ");
  assert.ok(message.includes("Usage: /rename <new-title>"));
});

test("RenameCommand calls session.thread.rename and confirms to user", async () => {
  let message = "";
  let renamedPayload: any;
  const handler = createRenameCommandHandler({
    session: {
      thread: {
        getId: () => "thread-123",
        rename: async (payload: any) => {
          renamedPayload = payload;
        },
      },
    } as any,
    getApp: () => undefined,
    showMessage: (msg) => {
      message = msg;
    },
    isTurnActive: () => false,
  });

  await handler("Refactor Auth Module");
  assert.deepEqual(renamedPayload, {
    title: "Refactor Auth Module",
  });
  assert.ok(message.includes('Renamed thread to: "Refactor Auth Module"'));
});
