import assert from "node:assert/strict";
import test from "node:test";
import { ActionDispatcher } from "../src/dispatcher.js";
import { createStatusLineCommand } from "../src/commands/statusline.command.js";

test("StatusLineCommand emits dialog:statusline_picker event", async () => {
  const emittedEvents: any[] = [];
  const dispatcher = new ActionDispatcher();
  dispatcher.subscribe((evt) => {
    emittedEvents.push(evt);
  });

  const handler = createStatusLineCommand({
    dispatcher,
  });

  await handler("/statusline");

  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].type, "dialog:statusline_picker");
});
