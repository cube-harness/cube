import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceManager } from "@cube/workspace";
import { createMastraWorkspace } from "../src/workspace.js";

test("LocalSandbox tells the model which shell executes commands", async () => {
  const manager = {
    getPaths: async () => ({ root: process.cwd() }),
  } as unknown as WorkspaceManager;

  const workspace = await createMastraWorkspace(manager);
  const instructions = workspace.sandbox.getInstructions();

  assert.match(instructions, /Local command execution/);

  if (process.platform === "win32") {
    assert.match(instructions, /cmd\.exe/);
    assert.match(instructions, /powershell -NoProfile -Command/);
  } else {
    assert.match(instructions, /POSIX shell/);
  }
});
