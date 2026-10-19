import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { CubeHome, CubeWorkspace, PermissionsSchema, createBootstrap } from "@cube/workspace";
import { configureCubePermissions } from "@cube/agent";
import { PermissionService } from "../../src/services/permission.service.js";
const { Session } = createRequire(import.meta.resolve("@cube/agent"))("@mastra/core/agent-controller");

test("Apply persists one workspace, replaces live policies and rejects busy or failed application", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cube-live-permissions-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = CubeHome({ cubeHome: join(root, "home") });
  await createBootstrap(home).run();
  await Promise.all([mkdir(join(root, "first")), mkdir(join(root, "second"))]);
  const workspace = CubeWorkspace(home, join(root, "first"));
  const other = CubeWorkspace(home, join(root, "second"));
  await workspace.setTrust(true);
  await other.setTrust(true);
  const otherBefore = await other.getPermission();
  const current = PermissionsSchema.parse({});
  const session = new Session({ id: "permission-apply", ownerId: "test", resourceId: "test" });
  let nativeState: Record<string, unknown> = {};
  session.permissions.setResolver({ getState: () => nativeState,
    setState: async (updates: Record<string, unknown>) => { nativeState = { ...nativeState, ...updates }; } });
  await configureCubePermissions(session, current);
  let busy = false;
  let fail = false;
  const service = new PermissionService(workspace, current, {
    listTools: async () => ["read_file", "fetch", "execute_command", "edit_file", "write_file", "apply_patch", "docs_lookup"],
    listMcpTools: () => ["docs_lookup"],
    isBusy: () => busy,
    apply: async (permissions) => {
      await configureCubePermissions(session, permissions);
      if (fail) { fail = false; throw new Error("Cannot apply"); }
      Object.assign(current, permissions);
    },
  });
  const draft = await service.get();
  assert.equal(draft.tools.docs_lookup, "ask");
  draft.tools.docs_lookup = "allow";
  draft.workspaceOnly = false;
  draft.tools.read_file = "deny";
  draft.tools.write_file = "allow";
  draft.tools.fetch = "ask";
  await service.set(draft);
  assert.equal(service.isApplying(), false);
  assert.equal((await service.get()).workspaceOnly, false);
  assert.equal(session.resolveToolApproval("read_file"), "deny");
  assert.equal(session.resolveToolApproval("write_file"), "allow");
  assert.equal(session.resolveToolApproval("fetch"), "ask");
  assert.equal(session.resolveToolApproval("docs_lookup"), "allow");
  assert.ok((await workspace.getPermission())?.permissions.allow_for?.includes("docs_lookup"));
  assert.deepEqual((await workspace.getPermission())?.permissions, current);
  assert.deepEqual(await other.getPermission(), otherBefore);
  const bytes = await readFile(home.getPermissionPath(), "utf8");
  busy = true;
  await assert.rejects(service.set(draft), /current turn/);
  assert.equal(await readFile(home.getPermissionPath(), "utf8"), bytes);
  busy = false;
  fail = true;
  draft.tools.fetch = "deny";
  await assert.rejects(service.set(draft), /Cannot apply/);
  assert.equal(session.resolveToolApproval("fetch"), "ask");
  assert.equal(await readFile(home.getPermissionPath(), "utf8"), bytes);
  assert.equal(service.isApplying(), false);
  await other.setPermissions({ workspace_only: true, require_approval_for: [], deny_for: ["fetch"] });
  assert.equal((await workspace.getPermission())?.permissions.workspace_only, false);
});
