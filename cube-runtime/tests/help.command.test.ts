import assert from "node:assert/strict";
import test from "node:test";
import { CommandManager } from "../src/command-manager.js";
import { createHelpCommand } from "../src/commands/help.command.js";

test("HelpCommand outputs a Markdown table of registered commands", async () => {
  let output = "";
  const commandManager = new CommandManager((msg) => {
    output = msg;
  });

  commandManager.registerMany([
    {
      name: "/model",
      description: "View and select AI models",
      handler: async () => {},
    },
    {
      name: "/new",
      description: "Start a fresh thread session",
      handler: async () => {},
    },
    {
      name: "/help",
      description: "Show available commands",
      handler: createHelpCommand({
        commandManager,
        showMessage: (msg) => {
          output = msg;
        },
      }),
    },
  ]);

  await commandManager.execute("/help");

  assert.ok(output.includes("### 📖 Available Slash Commands"));
  assert.ok(output.includes("`/model`"));
  assert.ok(output.includes("`/new`"));
  assert.ok(output.includes("`/help`"));
});
