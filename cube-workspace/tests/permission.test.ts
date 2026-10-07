import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CubeHome, CubeWorkspace, PermissionStore, PermissionsSchema, createBootstrap } from "../src/index.js";

test("workspace registry saves trust only and preserves independent permission overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cube-permission-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = CubeHome({ cubeHome: join(root, "home") });
  await createBootstrap(home).run();
  const firstPath = join(root, "first"), secondPath = join(root, "second");
  await Promise.all([mkdir(firstPath), mkdir(secondPath)]);
  const first = CubeWorkspace(home, firstPath), second = CubeWorkspace(home, secondPath);
  assert.equal(await first.getPermission(), undefined);
  const initialBytes = await readFile(home.getPermissionPath(), "utf8");
  await second.setTrust(false);
  assert.equal(await readFile(home.getPermissionPath(), "utf8"), initialBytes);
  await first.setTrust(true);
  assert.equal((await first.getPermission())?.trusted, true);
  assert.equal(await second.getPermission(), undefined);
  assert.deepEqual(JSON.parse(await readFile(home.getPermissionPath(), "utf8")).workspaces[0].permissions, {
    workspace_only: true,
    require_approval_for: ["execute_command", "edit_file", "write_file", "apply_patch"],
    deny_for: [],
    allow_for: [],
  });
  await PermissionStore(home).update((registry) => ({ workspaces: registry.workspaces.map((entry) =>
    entry.trusted ? { ...entry, permissions: { workspace_only: false, require_approval_for: [] } } : entry) }));
  await first.setTrust(false);
  await first.setTrust(true);
  const entry = await CubeWorkspace(home, join(firstPath, ".")).getPermission();
  assert.equal(entry?.path, await realpath(firstPath));
  assert.deepEqual(entry?.permissions, { workspace_only: false, require_approval_for: [], deny_for: [], allow_for: [] });
  assert.equal((await PermissionStore(home).read()).workspaces.length, 1);
  assert.deepEqual(PermissionsSchema.parse(entry?.permissions), { workspace_only: false, require_approval_for: [], deny_for: [], allow_for: [] });
  await PermissionStore(home).update((registry) => ({ workspaces: registry.workspaces.map((saved) =>
    ({ ...saved, permissions: { require_approval_for: [] } })) }));
  await first.setTrust(true);
  assert.deepEqual(JSON.parse(await readFile(home.getPermissionPath(), "utf8")).workspaces[0].permissions, {
    workspace_only: true,
    require_approval_for: [],
    deny_for: [],
    allow_for: [],
  });
});
