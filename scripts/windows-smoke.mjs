import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// This file runs inside the deployed app, never resolves dependencies via the repo.
await import("@cube/runtime");
const { CubeHome, CubeWorkspace, createBootstrap, ConfigStore, RunnableConfigSchema } = await import("@cube/workspace");
const { createCubeAgent } = await import("@cube/agent");
const { createWorkspaceTools } = await import("@mastra/core/workspace");
const { LibSQLStore } = await import("@mastra/libsql");
const { loadInitializePrompt } = await import(new URL("./processors/initialize.processor.js", import.meta.resolve("@cube/agent")));
const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "cube-windows-smoke-")));
const cwd = process.cwd();
let agent;
let storage;
try {
  const project = path.join(scratch, "project with spaces");
  await mkdir(project);
  await writeFile(path.join(project, "AGENTS.md"), "Packaged workspace smoke fixture.\n");
  process.chdir(project);
  const home = CubeHome({ cubeHome: path.join(scratch, "home"), userHome: scratch });
  await createBootstrap(home).run();
  assert.deepEqual(JSON.parse(await readFile(home.getAuthPath(), "utf8")), { api_keys: {}, oauth: {} });
  assert.ok(loadInitializePrompt().length > 0);
  const config = RunnableConfigSchema.parse({ ...await ConfigStore(home).read(), gateway: "api_key/google", model: "google/test" });
  agent = await createCubeAgent(home, CubeWorkspace(home, project), config);
  const workspace = await agent.getWorkspace();
  assert.equal(workspace.filesystem.basePath, project);
  const tools = await createWorkspaceTools(workspace);
  assert.deepEqual(Object.keys(tools).sort(), ["grep", "list_files", "read_file"]);
  await writeFile(path.join(project, "probe.txt"), "CUBE_WINDOWS_OK\n");
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = "";
    assert.match(await tools.grep.execute({ pattern: "CUBE_WINDOWS_OK" }), /probe.txt:1:1/);
    assert.match(await tools.read_file.execute({ path: "probe.txt" }), /CUBE_WINDOWS_OK/);
    assert.match(await tools.list_files.execute({ path: "." }), /probe.txt/);
  } finally { process.env.PATH = previousPath; }
  const commands = await agent.listTools();
  const result = await commands.execute_command.execute({ command: "echo CUBE_COMMAND_OK", reason: "Verify packaged command execution" }, {});
  assert.equal(result.exit_code, 0);
  assert.equal(await realpath(result.cwd), await realpath(project));
  assert.match(result.output, /CUBE_COMMAND_OK/);
  storage = new LibSQLStore({ id: "smoke", url: `file:${home.getMemoryDbPath()}` });
  await storage.init();
  console.log("windows-smoke: native tools, command, templates and SQLite OK outside checkout");
} finally {
  await agent?.disposeTools();
  await storage?.close();
  process.chdir(cwd);
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
