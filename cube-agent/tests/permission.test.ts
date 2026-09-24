import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "@mastra/core/agent-controller";
import type { CubeConfig } from "@cube/workspace";
import {
  configureCubePermissions,
  resolveCubeToolCategory,
} from "../src/permission.js";

test("retired approval names report a mismatch and block mutations instead of losing protection", async () => {
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

  const notices = await configureCubePermissions(session as never, permissions);
  assert.match(notices[0], /mastra_workspace_delete/);

  assert.deepEqual(calls, [
    ["category", { category: "other", policy: "allow" }],
    ...["edit_file", "write_file", "apply_patch"].map((toolName) => ["tool", { toolName, policy: "allow" }]),
    ["tool", { toolName: "execute_command", policy: "ask" }],
    ["tool", { toolName: "mastra_workspace_delete", policy: "ask" }],
    ...["edit_file", "write_file", "apply_patch", "execute_command"].map((toolName) => ["tool", { toolName, policy: "deny" }]),
  ]);
  assert.equal(resolveCubeToolCategory("ask_user"), "other");
});

test("corrected config clears a fail-closed block and keeps approval across model families", async () => {
  const session = new Session({ id: "rules", ownerId: "test", resourceId: "test" });
  let state: Record<string, unknown> = {};
  session.permissions.setResolver({ getState: () => state, setState: async (updates) => { state = { ...state, ...updates }; } });
  await configureCubePermissions(session, { require_approval_for: ["mastra_workspace_delete"] });
  assert.equal(session.resolveToolApproval("apply_patch"), "deny");
  await configureCubePermissions(session, { require_approval_for: ["execute_command"] });
  assert.equal(session.resolveToolApproval("apply_patch"), "allow");
  assert.equal(session.resolveToolApproval("execute_command"), "ask");
  await configureCubePermissions(session, { require_approval_for: ["write_file", "fetch"] });
  for (const name of ["edit_file", "write_file", "apply_patch", "fetch"]) assert.equal(session.resolveToolApproval(name), "ask");
});
