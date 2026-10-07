import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "@mastra/core/agent-controller";
import type { CubeConfig } from "@cube/workspace";
import {
  configureCubePermissions,
  resolveCubeToolCategory,
} from "../src/permission.js";

test("retired approval names report a mismatch and block mutations instead of losing protection", async () => {
  const session = new Session({ id: "retired-rules", ownerId: "test", resourceId: "test" });
  let state: Record<string, unknown> = {};
  session.permissions.setResolver({ getState: () => state, setState: async (updates) => { state = { ...state, ...updates }; } });
  const permissions = {
    require_approval_for: ["execute_command", "mastra_workspace_delete"],
  } as CubeConfig["permissions"];

  const notices = await configureCubePermissions(session as never, permissions);
  assert.match(notices[0], /mastra_workspace_delete/);

  for (const name of ["edit_file", "write_file", "apply_patch", "execute_command"])
    assert.equal(session.resolveToolApproval(name), "deny");
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
  for (const name of ["write_file", "fetch"]) assert.equal(session.resolveToolApproval(name), "ask");
  for (const name of ["edit_file", "apply_patch"]) assert.equal(session.resolveToolApproval(name), "allow");
});

test("tool policies are independent and Apply clears previous Ask and Deny rules", async () => {
  const session = new Session({ id: "live-rules", ownerId: "test", resourceId: "test" });
  let state: Record<string, unknown> = {};
  session.permissions.setResolver({ getState: () => state, setState: async (updates) => { state = { ...state, ...updates }; } });
  session.grantTool("read_file");
  await configureCubePermissions(session, {
    require_approval_for: ["write_file"], deny_for: ["read_file", "fetch"],
  });
  assert.equal(session.resolveToolApproval("write_file"), "ask");
  assert.equal(session.resolveToolApproval("edit_file"), "allow");
  assert.equal(session.resolveToolApproval("apply_patch"), "allow");
  assert.equal(session.resolveToolApproval("read_file"), "deny");
  await configureCubePermissions(session, { require_approval_for: ["read_file"], deny_for: [] });
  assert.equal(session.resolveToolApproval("read_file"), "ask");
  assert.equal(session.resolveToolApproval("fetch"), "allow");
  assert.equal(session.resolveToolApproval("write_file"), "allow");
});

test("fresh MCP names receive Ask before publication and retained explicit Allow survives removal", async () => {
  const session = new Session({ id: "mcp-permissions", ownerId: "test", resourceId: "test" });
  let state: Record<string, unknown> = {};
  session.permissions.setResolver({ getState: () => state, setState: async updates => { state = { ...state, ...updates }; } });
  await configureCubePermissions(session, { require_approval_for: [], allow_for: ["docs_saved"] }, ["docs_saved", "docs_new"]);
  assert.equal(session.resolveToolApproval("docs_saved"), "allow");
  assert.equal(session.resolveToolApproval("docs_new"), "ask");
  await configureCubePermissions(session, { require_approval_for: [], allow_for: ["docs_saved"] });
  assert.equal(session.resolveToolApproval("docs_saved"), "allow");
  assert.equal(session.resolveToolApproval("docs_new"), "allow");
  await configureCubePermissions(session, { require_approval_for: [], allow_for: ["docs_saved"] }, ["docs_saved", "docs_new"]);
  assert.equal(session.resolveToolApproval("docs_new"), "ask");
});
