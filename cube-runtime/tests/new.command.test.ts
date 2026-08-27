import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "@cube/agent";
import { ActionDispatcher } from "../src/dispatcher.js";
import { createNewCommand } from "../src/commands/new.command.js";
import type { CubeUIEvent } from "../src/contracts/ui.contract.js";

const createMockSession = (overrides?: {
  isRunning?: boolean;
  onDetach?: () => void;
  onClearLock?: () => void;
}) => {
  return {
    run: {
      isRunning: () => overrides?.isRunning ?? false,
    },
    thread: {
      detachFromCurrent: () => overrides?.onDetach?.(),
      clearAndReleaseLock: async () => overrides?.onClearLock?.(),
    },
  } as unknown as Session;
};

test("NewCommand blocks execution when agent turn is active", async () => {
  let detached = false;
  const session = createMockSession({
    isRunning: true,
    onDetach: () => {
      detached = true;
    },
  });
  const dispatcher = new ActionDispatcher();
  const events: CubeUIEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createNewCommand({
    session,
    dispatcher,
  });

  await handler("");
  assert.equal(detached, false);
  const sysMsg = events.find((e) => e.type === "system:message") as any;
  assert.match(sysMsg?.content, /Cannot start new thread while an agent turn is active/);
});

test("NewCommand detaches thread, clears messages, and updates info", async () => {
  let detached = false;
  let rotated = false;
  let soulReloaded = false;

  const session = createMockSession({
    isRunning: false,
    onDetach: () => {
      detached = true;
    },
  });
  const dispatcher = new ActionDispatcher();
  const events: CubeUIEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createNewCommand({
    session,
    dispatcher,
    reloadSoul: async () => {
      soulReloaded = true;
    },
    onNewThread: () => {
      rotated = true;
    },
  });

  await handler("");
  assert.equal(detached, true);
  assert.equal(rotated, true);
  assert.equal(soulReloaded, true);

  const clearEvent = events.find((e) => e.type === "messages:clear");
  assert.ok(clearEvent);

  const infoEvent = events.find((e) => e.type === "state:info") as any;
  assert.equal(infoEvent?.info?.threadId, "new thread");
});

test("NewCommand catches oversized soul errors and halts thread creation", async () => {
  let detached = false;
  const session = createMockSession({
    isRunning: false,
    onDetach: () => {
      detached = true;
    },
  });
  const dispatcher = new ActionDispatcher();
  const events: CubeUIEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createNewCommand({
    session,
    dispatcher,
    reloadSoul: async () => {
      throw new Error("SOUL.md exceeds max length (25000/20000 characters)");
    },
  });

  await handler("");
  assert.equal(detached, false);
  const sysMsg = events.find((e) => e.type === "system:message") as any;
  assert.match(sysMsg?.content, /Cannot start new thread: SOUL\.md exceeds max length/);
});
