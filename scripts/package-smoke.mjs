import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { MDocument } from "@mastra/rag";
import { LibSQLVector } from "@mastra/libsql";

// This file runs inside the deployed app, never resolves dependencies via the repo.
const { McpService, SubagentService } = await import("@cube/runtime");
const { CubeHome, CubeWorkspace, createBootstrap, getBuiltinSkillsPath, ConfigStore, RunnableConfigSchema, McpStore, AuthStore } = await import("@cube/workspace");
const { createCubeMastra, INITIALIZE_PROMPT, CubeMcp, BUILTIN_SUBAGENTS, createNativeSubagents } = await import("@cube/agent");
assert.equal(typeof SubagentService, "function");
assert.equal(typeof createNativeSubagents, "function");
assert.deepEqual(BUILTIN_SUBAGENTS.map(role => role.name), ["explore", "worker"]);
const { createWorkspaceTools } = await import("@mastra/core/workspace");
const { RequestContext } = await import("@mastra/core/request-context");
const { LibSQLStore } = await import("@mastra/libsql");
const { resolveAgentSkills } = await import("@mastra/core/skills");
const parentScratch = process.argv[2];
const scratch = await realpath(parentScratch ?? await mkdtemp(path.join(tmpdir(), "cube-package-smoke-")));
const cwd = process.cwd();
let agent;
let storage;
let mcp;
let composition;
try {
  const ragText = "repeat tiếng Việt 😀\n".repeat(30);
  const ragChunks = await MDocument.fromText(ragText).chunk({ strategy: "recursive", maxSize: 128, overlap: 16,
    separatorPosition: "end", addStartIndex: true, stripWhitespace: false });
  assert.ok(ragChunks.length > 1);
  assert.ok(ragChunks.every(chunk => ragText.slice(chunk.metadata.startIndex, chunk.metadata.startIndex + chunk.text.length) === chunk.text));
  const vectors = new LibSQLVector({ id: "rag-package-smoke", url: `file:${path.join(scratch, "vectors.sqlite")}` });
  try {
    await vectors.createIndex({ indexName: "rag_smoke", dimension: 2, metric: "cosine" });
    await vectors.upsert({ indexName: "rag_smoke", ids: ["smoke"], vectors: [[1, 0]], metadata: [{ project: "smoke" }] });
    assert.equal((await vectors.query({ indexName: "rag_smoke", queryVector: [1, 0], topK: 1 }))[0].id, "smoke");
    await vectors.updateVector({ indexName: "rag_smoke", id: "smoke", update: { metadata: { project: "updated" } } });
    assert.equal((await vectors.query({ indexName: "rag_smoke", queryVector: [1, 0], topK: 1 }))[0].metadata.project, "updated");
    await vectors.deleteVector({ indexName: "rag_smoke", id: "smoke" });
    assert.equal((await vectors.query({ indexName: "rag_smoke", queryVector: [1, 0], topK: 1 })).length, 0);
    await vectors.deleteIndex({ indexName: "rag_smoke" });
  } finally { await vectors.close(); }
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
  composition = await createCubeMastra(home, CubeWorkspace(home, project), config);
  agent = composition.agent;
  const builtinNames = ["cube-background", "cube-delegation", "cube-memory", "skill-creator"];
  const assets = await getBuiltinSkillsPath();
  for (const location of [assets, path.join(assets, "..", "dist", "skills")]) {
    const shipped = resolveAgentSkills([location]);
    assert.deepEqual((await shipped.list()).map(skill => skill.name).sort(), builtinNames);
    for (const name of builtinNames) assert.ok((await shipped.get(name))?.instructions.trim());
    assert.ok(await shipped.getReference("skill-creator", "license.txt"));
    assert.ok(await shipped.getReference("skill-creator", "references/cube_skills.md"));
    assert.ok(await shipped.getReference("skill-creator", "assets/skill-template.md"));
    const creator = path.join(location, "skill-creator");
    const destination = path.join(project, location === assets ? "creator-main" : "creator-dist");
    execFileSync(process.execPath, [path.join(creator, "scripts/init_skill.mjs"), "smoke-skill", "--path", destination], {
      cwd: project, windowsHide: true, env: { ...process.env, PATH: "" },
    });
    const generated = path.join(destination, "smoke-skill");
    await writeFile(path.join(generated, "SKILL.md"), '---\nname: smoke-skill\ndescription: "Use when verifying packaged authoring helpers."\nuser-invocable: false\n---\n# Fixture\nUse current evidence.\n');
    const checked = execFileSync(process.execPath, [path.join(creator, "scripts/quick_validate.mjs"), generated], {
      cwd: project, windowsHide: true, env: { ...process.env, PATH: "" }, encoding: "utf8",
    });
    assert.match(checked, /Authoring checks passed/);
    assert.equal((await resolveAgentSkills([destination]).list())[0]?.name, "smoke-skill");
  }
  assert.deepEqual((await composition.skills.list()).filter(skill => skill.source === "builtin").map(skill => skill.name), builtinNames);
  const native = await agent.getToolsForExecution({ requestContext: new RequestContext(), methodType: "stream", backgroundTaskEnabled: false });
  const roleProcessor = await agent.resolveProcessorById("cube-subagent-tools");
  const published = await roleProcessor.processInputStep({ tools: native, requestContext: new RequestContext() });
  assert.ok(published.tools.worker?.execute && published.tools.explore?.execute);
  assert.equal(published.tools["agent-worker"], undefined);
  assert.equal(native.spawn_agent, undefined);
  assert.match(String(await native.skill.execute({ name: "cube-background" }, {})), /Cube Background Work/);
  assert.match(JSON.stringify(await native.skill_read.execute({ skillName: "skill-creator", path: "license.txt" }, {})), /Apache License/);
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
  assert.ok(commands.manage_subagent);
  assert.equal(commands.get_process, undefined);
  assert.equal(commands.kill_process, undefined);
  const result = await commands.execute_command.execute({ command: "echo CUBE_COMMAND_OK", reason: "Verify packaged command execution" }, {});
  assert.equal(result.exit_code, 0);
  assert.equal(await realpath(result.cwd), await realpath(project));
  assert.match(result.output, /CUBE_COMMAND_OK/);
  const overflow = await commands.execute_command.execute({
    command: 'node -e "process.stdout.write(\'PACKAGE_FULL_OUTPUT\\n\'.repeat(250))"',
    reason: "Verify packaged foreground output preservation",
  }, { agent: { threadId: "package-output" } });
  assert.equal(overflow.exit_code, 0);
  assert.ok(overflow.truncated && overflow.read_more && overflow.log_available);
  const page = await composition.tools.processes.readOutput(overflow.process_id, 0, 2000);
  assert.equal(page.output, "PACKAGE_FULL_OUTPUT\n".repeat(250));
  // Only the shipped runtime is on PATH: a host-installed rg cannot hide a missing binary.
  const runtime = fileURLToPath(new URL("../runtime/", import.meta.url));
  try {
    process.env.PATH = runtime;
    const rg = await commands.execute_command.execute({
      command: 'rg -n -F -- "CUBE_PACKAGE_OK" "probe.txt"',
      reason: "Verify bundled ripgrep through the command tool without host PATH",
    }, {});
    assert.equal(rg.exit_code, 0, rg.output);
    assert.match(rg.output, /1:CUBE_PACKAGE_OK/);
    const files = await commands.execute_command.execute({
      command: 'rg --files -g "probe.txt"',
      reason: "Verify bundled ripgrep file discovery",
    }, {});
    assert.equal(files.exit_code, 0, files.output);
    assert.equal(files.output.trim(), "probe.txt");
    const missing = await commands.execute_command.execute({
      command: 'rg -n -F -- "NO_SUCH_PACKAGE_SMOKE_MATCH" "probe.txt"',
      reason: "Verify no matches is exit 1, not a missing executable",
    }, {});
    assert.equal(missing.exit_code, 1, missing.output);
  } finally { process.env.PATH = previousPath; }
  for (const name of ["COPYING", "LICENSE-MIT", "UNLICENSE"])
    assert.ok((await readFile(path.join(runtime, `ripgrep-${name}`), "utf8")).trim());
  storage = new LibSQLStore({ id: "smoke", url: `file:${home.getMemoryDbPath()}` });
  await storage.init();
  console.log("package-smoke: native tools, built-in skills/resources, command, bundled ripgrep, templates and SQLite OK outside checkout");
} finally {
  await mcp?.dispose();
  await composition?.shutdown();
  await storage?.close();
  process.chdir(cwd);
  if (!parentScratch) await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
