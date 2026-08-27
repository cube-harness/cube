import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "@cube/agent";
import { ActionDispatcher } from "../src/dispatcher.js";
import { createThreadSelectHandler } from "../src/handlers/thread-select.handler.js";
import type { CubeUIEvent } from "../src/contracts/ui.contract.js";

test("thread selection relies on native thread_changed instead of emitting converted history", async () => {
  let listMessagesCalls = 0;
  const session = {
    run: { isRunning: () => false },
    thread: {
      switch: async () => {},
      listMessages: async () => {
        listMessagesCalls += 1;
        return [];
      },
    },
  } as unknown as Session;
  const dispatcher = new ActionDispatcher();
  const events: CubeUIEvent[] = [];
  dispatcher.subscribe((event) => events.push(event));

  await createThreadSelectHandler({ session, dispatcher })("thread-1");

  assert.equal(listMessagesCalls, 0);
  assert.equal(events.some((event) => event.type === "state:info"), true);
});
