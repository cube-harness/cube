import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CubeHome, CubeWorkspace, PermissionStore, ConfigSchema, createBootstrap } from "../src/index.js";

test("workspace registry persists both trust choices and preserves independent permission overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cube-permission-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = CubeHome({ cubeHome: join(root, "home") });
  await createBootstrap(home).run();
  const firstPath = join(root, "first"), secondPath = join(root, "second");
  await Promise.all([mkdir(firstPath), mkdir(secondPath)]);
  const first = CubeWorkspace(home, firstPath), second = CubeWorkspace(home, secondPath);
  assert.equal(await first.getPermission(), undefined);
  await Promise.all([first.setTrust(true), second.setTrust(false)]);
  assert.equal((await first.getPermission())?.trusted, true);
  assert.equal((await second.getPermission())?.trusted, false);
  assert.deepEqual((await first.getPermission())?.permissions, {});
  await PermissionStore(home).update((registry) => ({ workspaces: registry.workspaces.map((entry) =>
    entry.trusted ? { ...entry, permissions: { workspace_only: false, require_approval_for: [] } } : entry) }));
  await first.setTrust(false);
  await first.setTrust(true);
  const entry = await CubeWorkspace(home, join(firstPath, ".")).getPermission();
  assert.equal(entry?.path, await realpath(firstPath));
  assert.deepEqual(entry?.permissions, { workspace_only: false, require_approval_for: [] });
  assert.equal((await PermissionStore(home).read()).workspaces.length, 2);
  const global = ConfigSchema.parse({ permissions: { require_approval_for: ["execute_command"] } });
  assert.deepEqual({ ...global.permissions, ...entry?.permissions }, { workspace_only: false, require_approval_for: [] });
});
