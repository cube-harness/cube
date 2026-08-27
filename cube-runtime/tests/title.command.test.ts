import assert from "node:assert/strict";
import test from "node:test";
import { ActionDispatcher } from "../src/dispatcher.js";
import { createTitleCommand } from "../src/commands/title.command.js";

test("TitleCommand emits dialog:title_picker event", async () => {
  const emittedEvents: any[] = [];
  const dispatcher = new ActionDispatcher();
  dispatcher.subscribe((evt) => {
    emittedEvents.push(evt);
  });

  const handler = createTitleCommand({
    dispatcher,
  });

  await handler("/title");

  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].type, "dialog:title_picker");
});
