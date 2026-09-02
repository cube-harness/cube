import assert from "node:assert/strict";
import test from "node:test";
import type { CubeConfig } from "@cube/workspace";
import {
  configureCubePermissions,
  resolveCubeToolCategory,
} from "../src/permission.js";

test("configureCubePermissions applies defaults and configured tool aliases", async () => {
  const calls: unknown[][] = [];
  const session = {
    permissions: {
      setForCategory: async (input: unknown) => calls.push(["category", input]),
      setForTool: async (input: unknown) => calls.push(["tool", input]),
    },
  };
  const permissions = {
    require_approval_for: ["execute_command", "mastra_workspace_delete"],
  } as CubeConfig["permissions"];

  await configureCubePermissions(session as never, permissions);

  assert.deepEqual(calls, [
    ["category", { category: "other", policy: "allow" }],
    ["tool", { toolName: "execute_command", policy: "ask" }],
    ["tool", { toolName: "mastra_workspace_execute_command", policy: "ask" }],
    ["tool", { toolName: "mastra_workspace_delete", policy: "ask" }],
  ]);
  assert.equal(resolveCubeToolCategory("ask_user"), "other");
});
