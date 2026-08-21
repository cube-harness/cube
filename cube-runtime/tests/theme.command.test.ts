import assert from "node:assert/strict";
import test from "node:test";
import { CubeHome } from "@cube/workspace";
import { ActionDispatcher } from "../src/dispatcher.js";
import { createThemeCommandHandler } from "../src/commands/theme.command.js";
import type { CubeEvent } from "../src/contracts/events.contract.js";

test("ThemeCommand blocks execution when agent turn is active", async () => {
  const home = CubeHome();
  const dispatcher = new ActionDispatcher();
  let emittedEvent: CubeEvent | undefined;
  dispatcher.subscribe((e) => {
    emittedEvent = e;
  });

  const handler = createThemeCommandHandler({
    home,
    dispatcher,
    isTurnActive: () => true,
  });

  await handler("");
  assert.equal(emittedEvent?.type, "system:message");
  assert.equal((emittedEvent as any)?.content, "Cannot change theme while an agent turn is active.");
});

test("ThemeCommand opens interactive dialog when called without arguments", async () => {
  const home = CubeHome();
  const dispatcher = new ActionDispatcher();
  let dialogEvent: any;
  dispatcher.subscribe((e) => {
    if (e.type === "dialog:theme") {
      dialogEvent = e;
    }
  });

  const handler = createThemeCommandHandler({
    home,
    dispatcher,
    isTurnActive: () => false,
  });

  await handler("");
  assert.ok(dialogEvent);
  assert.ok(dialogEvent.currentThemeId);
});

test("ThemeCommand handles argument directly", async () => {
  const home = CubeHome();
  const dispatcher = new ActionDispatcher();
  let systemMsg = "";
  let selected = "";
  dispatcher.subscribe((e) => {
    if (e.type === "system:message") {
      systemMsg = e.content;
    }
  });

  const handler = createThemeCommandHandler({
    home,
    dispatcher,
    isTurnActive: () => false,
    onThemeSelected: (t) => {
      selected = t;
    },
  });

  await handler("dracula");
  assert.equal(selected, "dracula");
  assert.ok(systemMsg.includes("dracula"));
});
