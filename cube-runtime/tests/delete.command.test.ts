import assert from "node:assert/strict";
import test from "node:test";
import { ActionDispatcher } from "../src/dispatcher.js";
import { createDeleteCommandHandler } from "../src/commands/delete.command.js";
import type { CubeEvent } from "../src/contracts/events.contract.js";

test("DeleteCommand blocks execution when agent turn is active", async () => {
  const dispatcher = new ActionDispatcher();
  const events: CubeEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createDeleteCommandHandler({
    session: {} as any,
    dispatcher,
    isTurnActive: () => true,
  });

  await handler("");
  const sysMsg = events.find((e) => e.type === "system:message") as any;
  assert.ok(sysMsg?.content?.includes("Cannot delete thread while an agent turn is active"));
});

test("DeleteCommand deletes specified threadId directly", async () => {
  let deletedId = "";
  const dispatcher = new ActionDispatcher();
  const events: CubeEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createDeleteCommandHandler({
    session: {
      thread: {
        getId: () => "active-thread-1",
        delete: async ({ threadId }: { threadId: string }) => {
          deletedId = threadId;
        },
      },
    } as any,
    dispatcher,
    isTurnActive: () => false,
  });

  await handler("other-thread-2");
  assert.equal(deletedId, "other-thread-2");
  const sysMsg = events.find((e) => e.type === "system:message") as any;
  assert.ok(sysMsg?.content?.includes("Deleted thread: other-thread-2"));
});

test("DeleteCommand resets active thread state when deleting current active thread", async () => {
  let deletedId = "";
  let detached = false;

  const dispatcher = new ActionDispatcher();
  const events: CubeEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

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
    dispatcher,
    isTurnActive: () => false,
  });

  await handler("active-thread-1");
  assert.equal(deletedId, "active-thread-1");
  assert.equal(detached, true);

  const clearEvent = events.find((e) => e.type === "messages:clear");
  assert.ok(clearEvent);

  const infoEvent = events.find((e) => e.type === "state:info") as any;
  assert.equal(infoEvent?.info?.threadId, "new thread");
});
