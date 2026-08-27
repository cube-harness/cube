import assert from "node:assert/strict";
import test from "node:test";
import { ActionDispatcher } from "../src/dispatcher.js";
import type { CubeUIAction, CubeUIEvent } from "../src/contracts/ui.contract.js";

test("ActionDispatcher dispatches actions to actionHandler", async () => {
  const dispatcher = new ActionDispatcher();
  let receivedAction: CubeUIAction | undefined;

  dispatcher.setActionHandler(async (action) => {
    receivedAction = action;
  });

  await dispatcher.dispatch({ type: "prompt:submit", content: "Test prompt" });
  assert.deepEqual(receivedAction, {
    type: "prompt:submit",
    content: "Test prompt",
  });
});

test("ActionDispatcher emits events to all subscribers", () => {
  const dispatcher = new ActionDispatcher();
  const received: CubeUIEvent[] = [];

  const unsubscribe = dispatcher.subscribe((event) => {
    received.push(event);
  });

  dispatcher.emit({
    type: "system:message",
    content: "System ready",
  });

  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, "system:message");

  unsubscribe();
  dispatcher.emit({
    type: "system:message",
    content: "Another message",
  });

  assert.equal(received.length, 1);
});
