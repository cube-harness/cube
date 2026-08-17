import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createWorkspaceResourceId,
  resolveWorkspaceIdentity,
  workspaceComparisonKey,
} from "../src/identity.js";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));

const createWorkspaceDirectory = (context: TestContext): string => {
  const directory = mkdtempSync(path.join(packageDirectory, ".test-identity-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test("workspace identity resolves the canonical filesystem path", (context) => {
  const directory = createWorkspaceDirectory(context);

  const identity = resolveWorkspaceIdentity(path.join(directory, "."));

  assert.equal(identity.canonicalPath, realpathSync.native(directory));
});

test("workspace resource IDs use a stable SHA-256 digest", () => {
  assert.equal(
    createWorkspaceResourceId("abc", "linux"),
    "workspace:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("Windows workspace comparison folds path case", () => {
  assert.equal(
    workspaceComparisonKey("C:\\Repo\\Cube", "win32"),
    workspaceComparisonKey("c:\\repo\\cube", "win32"),
  );
  assert.equal(
    createWorkspaceResourceId("ABC", "win32"),
    createWorkspaceResourceId("abc", "win32"),
  );
});

test("POSIX workspace comparison preserves path case", () => {
  assert.notEqual(
    workspaceComparisonKey("/Repo/Cube", "linux"),
    workspaceComparisonKey("/repo/cube", "linux"),
  );
  assert.notEqual(
    createWorkspaceResourceId("ABC", "linux"),
    createWorkspaceResourceId("abc", "linux"),
  );
});
