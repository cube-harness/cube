import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceManager } from "@cube/workspace";
import { createMastraWorkspace } from "../src/workspace.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceTools } from "@mastra/core/workspace";
import { RequestContext } from "@mastra/core/request-context";
import { createCubeTools } from "../src/tools/cube-tools.js";

test("live workspace scope changes affect existing custom tools and native read/list", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "cube-live-scope-"));
  const root = join(parent, "workspace");
  await mkdir(root);
  await writeFile(join(parent, "outside.txt"), "external");
  let contained = true;
  const workspace = await createMastraWorkspace({ getPaths: async () => ({ root }) } as WorkspaceManager,
    undefined, () => contained);
  const native = await createWorkspaceTools(workspace);
  const custom = createCubeTools(root, () => contained);
  t.after(async () => {
    await custom.dispose();
    await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const call = (name: string, input: unknown) => (native[name] as any).execute(input, { workspace, requestContext: new RequestContext() });
  const write = custom.forModel("google/test").write_file!;
  const command = custom.forModel("google/test").execute_command!;
  const writeOutside = () => write.execute!({ path: "../created.txt", content: "ok", overwrite: true } as never, {} as never) as Promise<any>;
  await assert.rejects(call("read_file", { path: "../outside.txt" }), /Permission denied/);
  assert.equal((await writeOutside()).status, "failed");
  await assert.rejects(command.transform!.display!.approval!({ input: { command: "echo ok", reason: "check scope", cwd: ".." } } as never), /Permission denied/);
  contained = false;
  assert.match(await call("read_file", { path: "../outside.txt" }), /external/);
  assert.match(await call("list_files", { path: ".." }), /outside.txt/);
  assert.equal((await writeOutside()).status, "applied");
  const approval = await command.transform!.display!.approval!({ input: { command: "echo ok", reason: "check scope", cwd: ".." } } as never) as any;
  assert.equal(approval.cwd, parent);
  contained = true;
  await assert.rejects(call("list_files", { path: ".." }), /Permission denied/);
  assert.equal((await writeOutside()).status, "failed");
});

test("workspace exposes only native read/list, without grep, native mutations or sandbox", async () => {
  const manager = {
    getPaths: async () => ({ root: process.cwd() }),
  } as unknown as WorkspaceManager;

  const workspace = await createMastraWorkspace(manager);
  assert.ok(workspace.filesystem);
  assert.equal(workspace.sandbox, undefined);
  assert.equal(workspace.getToolsConfig()?.enabled, false);
  assert.deepEqual(Object.keys(await createWorkspaceTools(workspace)).sort(), ["list_files", "read_file"]);
});

test("Cube read/list use the native workspace without external binaries on PATH", async (t) => {
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
  // Native read/list must work on a clean end-user machine without external binaries.
  const previousPath = process.env.PATH;
  t.after(() => { process.env.PATH = previousPath; });
  process.env.PATH = "";
  const read = await call("read_file", { path: "hello.txt", showLineNumbers: true });
  assert.match(read, /hello native/);
  const listing = await call("list_files", { path: ".", pattern: "*.txt" });
  assert.match(listing, /hello\.txt/);
  assert.doesNotMatch(listing, /ignored\.txt/);
  await assert.rejects(call("read_file", { path: "../outside.txt" }), /outside|denied/i);
});
