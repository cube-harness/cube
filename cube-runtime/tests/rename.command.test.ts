import assert from "node:assert/strict";
import test from "node:test";
import { ActionDispatcher } from "../src/dispatcher.js";
import { createRenameCommandHandler } from "../src/commands/rename.command.js";
import type { CubeEvent } from "../src/contracts/events.contract.js";

test("RenameCommand blocks execution when agent turn is active", async () => {
  const dispatcher = new ActionDispatcher();
  const events: CubeEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createRenameCommandHandler({
    session: { thread: { getId: () => "thread-1" } } as any,
    dispatcher,
    isTurnActive: () => true,
  });

  await handler("New Title");
  const sysMsg = events.find((e) => e.type === "system:message") as any;
  assert.ok(sysMsg?.content?.includes("Cannot rename thread while an agent turn is active"));
});

test("RenameCommand notifies when no active thread exists", async () => {
  const dispatcher = new ActionDispatcher();
  const events: CubeEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createRenameCommandHandler({
    session: { thread: { getId: () => null } } as any,
    dispatcher,
    isTurnActive: () => false,
  });

  await handler("New Title");
  const sysMsg = events.find((e) => e.type === "system:message") as any;
  assert.ok(sysMsg?.content?.includes("No active thread to rename"));
});

test("RenameCommand requires a non-empty title argument", async () => {
  const dispatcher = new ActionDispatcher();
  const events: CubeEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createRenameCommandHandler({
    session: { thread: { getId: () => "thread-1" } } as any,
    dispatcher,
    isTurnActive: () => false,
  });

  await handler("   ");
  const sysMsg = events.find((e) => e.type === "system:message") as any;
  assert.ok(sysMsg?.content?.includes("Usage: /rename <new-title>"));
});

test("RenameCommand calls session.thread.rename and confirms to user", async () => {
  let renamedPayload: any;
  const dispatcher = new ActionDispatcher();
  const events: CubeEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createRenameCommandHandler({
    session: {
      thread: {
        getId: () => "thread-123",
        rename: async (payload: any) => {
          renamedPayload = payload;
        },
      },
    } as any,
    dispatcher,
    isTurnActive: () => false,
  });

  await handler("Refactor Auth Module");
  assert.deepEqual(renamedPayload, {
    title: "Refactor Auth Module",
  });
  const sysMsg = events.find((e) => e.type === "system:message") as any;
  assert.ok(sysMsg?.content?.includes('Renamed thread to: "Refactor Auth Module"'));
});
