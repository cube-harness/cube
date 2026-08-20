import assert from "node:assert/strict";
import test from "node:test";
import { CommandManager } from "../src/command-manager.js";

test("CommandManager registers and executes commands", async () => {
  const messages: string[] = [];
  const manager = new CommandManager((msg) => messages.push(msg));

  let executedArg = "";
  manager.register({
    name: "/test",
    description: "Test command",
    handler: async (arg) => {
      executedArg = arg;
    },
  });

  assert.equal(manager.has("/test"), true);
  assert.equal(manager.has("/unknown"), false);

  await manager.execute("/test", "hello world");
  assert.equal(executedArg, "hello world");

  await manager.execute("/unknown");
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Unknown command/);
});

test("CommandManager formats suggestions with leading slash", () => {
  const manager = new CommandManager(() => {});
  manager.registerMany([
    { name: "/resume", description: "Resume thread", handler: async () => {} },
    { name: "new", description: "New thread", handler: async () => {} },
  ]);

  const suggestions = manager.suggestions;
  assert.deepEqual(suggestions, [
    { name: "/resume", description: "Resume thread" },
    { name: "/new", description: "New thread" },
  ]);
});
