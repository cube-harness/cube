import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// This file runs inside the deployed app, never resolves dependencies via the repo.
const { McpService, SubagentService } = await import("@cube/runtime");
const { CubeHome, CubeWorkspace, createBootstrap, ConfigStore, RunnableConfigSchema, McpStore, AuthStore } = await import("@cube/workspace");
const { createCubeAgent, INITIALIZE_PROMPT, CubeMcp, BUILTIN_SUBAGENTS, createSubagentChild, createSubagentTools } = await import("@cube/agent");
assert.equal(typeof SubagentService, "function");
assert.equal(typeof createSubagentChild, "function");
assert.deepEqual(BUILTIN_SUBAGENTS.map(role => role.name), ["explore", "worker"]);
assert.deepEqual(Object.keys(createSubagentTools("/smoke", () => BUILTIN_SUBAGENTS, {})).sort(),
  ["get_agent", "interrupt_agent", "list_agents", "send_message", "spawn_agent"]);
const { createWorkspaceTools } = await import("@mastra/core/workspace");
const { RequestContext } = await import("@mastra/core/request-context");
const { LibSQLStore } = await import("@mastra/libsql");
const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "cube-package-smoke-")));
const cwd = process.cwd();
let agent;
let storage;
let mcp;
try {
  const project = path.join(scratch, "project with spaces");
  await mkdir(project);
  await writeFile(path.join(project, "AGENTS.md"), "Packaged workspace smoke fixture.\n");
  process.chdir(project);
  const home = CubeHome({ cubeHome: path.join(scratch, "home"), userHome: scratch });
  await createBootstrap(home).run();
  mcp = new CubeMcp({ auth: new AuthStore(home), workspaceRoot: project });
  const mcpService = new McpService({ client: mcp, store: McpStore(home), isBusy: () => false, beforePublish: async () => undefined });
  await mcpService.reload();
  assert.deepEqual(mcp.readToolNames(), []);
  assert.deepEqual(mcpService.get().servers, []);
  assert.deepEqual(JSON.parse(await readFile(home.getAuthPath(), "utf8")), { api_keys: {}, oauth: {} });
  assert.ok(INITIALIZE_PROMPT.length > 0);
  const config = RunnableConfigSchema.parse({ ...await ConfigStore(home).read(), gateway: "api_key/google", model: "google/test" });
  agent = await createCubeAgent(home, CubeWorkspace(home, project), config);
  const workspace = await agent.getWorkspace();
  const filesystem = await workspace.resolveFilesystem({ requestContext: new RequestContext() });
  assert.equal(filesystem.basePath, project);
  const tools = await createWorkspaceTools(workspace);
  assert.deepEqual(Object.keys(tools).sort(), ["list_files", "read_file"]);
  await writeFile(path.join(project, "probe.txt"), "CUBE_PACKAGE_OK\n");
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = "";
    assert.match(await tools.read_file.execute({ path: "probe.txt" }), /CUBE_PACKAGE_OK/);
    assert.match(await tools.list_files.execute({ path: "." }), /probe.txt/);
  } finally { process.env.PATH = previousPath; }
  const commands = await agent.listTools();
  assert.ok(commands.manage_task);
  assert.equal(commands.get_process, undefined);
  assert.equal(commands.kill_process, undefined);
  const result = await commands.execute_command.execute({ command: "echo CUBE_COMMAND_OK", reason: "Verify packaged command execution" }, {});
  assert.equal(result.exit_code, 0);
  assert.equal(await realpath(result.cwd), await realpath(project));
  assert.match(result.output, /CUBE_COMMAND_OK/);
  storage = new LibSQLStore({ id: "smoke", url: `file:${home.getMemoryDbPath()}` });
  await storage.init();
  console.log("package-smoke: native tools, command, templates and SQLite OK outside checkout");
} finally {
  await mcp?.dispose();
  await agent?.disposeTools();
  await storage?.close();
  process.chdir(cwd);
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
