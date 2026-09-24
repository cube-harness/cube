import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceManager } from "@cube/workspace";
import { createMastraWorkspace } from "../src/workspace.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceTools } from "@mastra/core/workspace";

test("workspace exposes only native read/list/grep, without native mutations or sandbox", async () => {
  const manager = {
    getPaths: async () => ({ root: process.cwd() }),
  } as unknown as WorkspaceManager;

  const workspace = await createMastraWorkspace(manager);
  assert.ok(workspace.filesystem);
  assert.equal(workspace.sandbox, undefined);
  assert.equal(workspace.getToolsConfig()?.enabled, false);
  assert.deepEqual(Object.keys(await createWorkspaceTools(workspace)).sort(), ["grep", "list_files", "read_file"]);
});

test("Cube read/list/grep use the native workspace without ripgrep on PATH", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cube-native-read-"));
  const workspace = await createMastraWorkspace({
    getPaths: async () => ({ root }),
  } as unknown as WorkspaceManager);
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await writeFile(join(root, "hello.txt"), "hello native\nworld\n");
  await writeFile(join(root, "ignored.txt"), "hello hidden\n");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  const tools = await createWorkspaceTools(workspace);
  const call = (name: string, input: unknown) => (tools[name] as any).execute(input, { workspace });
  // A return to the custom rg-spawning tools breaks this on a clean end-user machine.
  const previousPath = process.env.PATH;
  t.after(() => { process.env.PATH = previousPath; });
  process.env.PATH = "";
  const read = await call("read_file", { path: "hello.txt", showLineNumbers: true });
  assert.match(read, /hello native/);
  assert.match(await call("list_files", { path: ".", pattern: "*.txt" }), /hello\.txt/);
  const matches = await call("grep", { pattern: "hello", path: "*.txt" });
  assert.match(matches, /hello\.txt:1:1: hello native/);
  assert.doesNotMatch(matches, /hello hidden/);
  assert.match(await call("grep", { pattern: "absent" }), /0 matches/);
  await assert.rejects(call("read_file", { path: "../outside.txt" }), /outside|denied/i);
});
