import assert from "node:assert/strict";
import test from "node:test";
import {
  createCompactCommandHandler,
  runCompactSlashCommand,
} from "../src/slash-commands/compact.slash-command.js";

test("keeps the busy-turn guard in the CLI command", async () => {
  let called = false;
  const output = await runCompactSlashCommand({
    threadId: "thread-1",
    turnActive: true,
    finalizeMemory: async () => {
      called = true;
      return { status: "no-op" };
    },
  });

  assert.equal(called, false);
  assert.equal(output, "Cannot compact while an agent turn is active.");
});

test("renders the agent finalize result as CLI output", async () => {
  const output = await runCompactSlashCommand({
    threadId: "thread-1",
    turnActive: false,
    finalizeMemory: async () => ({ status: "no-op" }),
  });

  assert.equal(output, "Nothing to compact.");
});

test("complete compact handler owns the missing-thread response", async () => {
  const messages: string[] = [];
  const handler = createCompactCommandHandler({
    getThreadId: () => null,
    isTurnActive: () => false,
    finalizeMemory: async () => ({ status: "no-op" }),
    showMessage: (message) => { messages.push(message); },
  });

  await handler("");
  assert.deepEqual(messages, ["No active thread to compact."]);
});
