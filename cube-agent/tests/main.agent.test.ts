import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { MessageList, createSignal } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  ConfigStore,
  CubeHome,
  CubeWorkspace,
  RunnableConfigSchema,
  createBootstrap,
} from "@cube/workspace";
import {
  buildModelConfig,
  createCubeAgent,
  reloadCubeAgentInstructions,
  updateCubeAgentModel,
} from "../src/agents/default.agent.js";
import { loadInstructionSnapshot, formatAgentsContext, refreshInstructionSnapshot } from "../src/prompts/system.prompt.js";
import { createCubeMastra } from "../src/bootstrap.js";
import { runWithCubeLogContext } from "../src/logger.js";

test("Cube operating instructions stay separate and stable when SOUL is reloaded", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-personality-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = CubeHome({ cubeHome: path.join(root, "home"), userHome: root });
  await createBootstrap(home).run();
  await writeFile(home.getSoulPath(), "Speak briefly.");
  const workspace = CubeWorkspace(home, root);
  const config = RunnableConfigSchema.parse({
    ...await ConfigStore(home).read(), gateway: "api_key/google", model: "google/test",
  });
  const mcpTools: Record<string, ReturnType<typeof createTool>> = {};
  const agent = await createCubeAgent(home, workspace, config, undefined, undefined, undefined, {
    readTools: () => mcpTools,
    readToolNames: () => Object.keys(mcpTools),
  });
  t.after(() => agent.disposeTools());
  assert.equal((await agent.listTools({ resolveWebSearch: false })).fetch, undefined);
  mcpTools.fetch = createTool({
    id: "fetch", description: "Fetch URL content from MCP", inputSchema: z.object({ url: z.string() }),
    execute: async () => "MCP content",
  });
  assert.equal((await agent.listTools({ resolveWebSearch: false })).fetch, mcpTools.fetch);
  const initial = await agent.getInstructions();
  assert.ok(Array.isArray(initial));
  assert.equal(initial.length, 3);
  assert.deepEqual(initial[1], { role: "system", content: "Speak briefly." });
  await writeFile(home.getSoulPath(), "Use a friendly tone.");
  assert.deepEqual(await agent.getInstructions(), initial);
  await reloadCubeAgentInstructions(agent, home, workspace);
  const updated = await agent.getInstructions();
  assert.ok(Array.isArray(updated));
  assert.deepEqual(updated[0], initial[0]);
  assert.deepEqual(updated[1], { role: "system", content: "Use a friendly tone." });
  assert.deepEqual(updated[2], initial[2]);
  agent.refreshPermissions();
  assert.deepEqual(await agent.getInstructions(), updated);
  assert.equal(agent.instructionInfo.soulCharacters, "Use a friendly tone.".length);
});

test("agent instructions retain SOUL and scoped AGENTS until explicitly reloaded", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-instructions-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = CubeHome({ cubeHome: path.join(root, "home") });
  const project = path.join(root, "project & test");
  const cwd = path.join(project, "src");
  await createBootstrap(home).run();
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(project, ".agents"));
  await mkdir(path.join(project, "unrelated"));
  const soul = "Cube behavior.\r\nKeep this exact prefix.\r\n";
  await writeFile(home.getSoulPath(), soul);
  await writeFile(home.getAgentsPath(), "Use npm. Answer in Vietnamese.");
  await writeFile(path.join(project, "AGENTS.md"), "Use pnpm.");
  await writeFile(path.join(project, ".agents", "AGENTS.md"), "Check meaningful changes.");
  await writeFile(path.join(project, "unrelated", "AGENTS.md"), "Unrelated rules.");
  const workspace = CubeWorkspace(home, project);
  assert.equal(await workspace.resolveRoot(), project);
  const nestedWorkspace = CubeWorkspace(home, cwd);
  assert.equal(await nestedWorkspace.resolveRoot(), cwd);
  assert.deepEqual(await nestedWorkspace.resolveContextFiles(), [], "a nested workspace must not load parent instructions outside its root");
  const config = RunnableConfigSchema.parse({
    ...await ConfigStore(home).read(),
    gateway: "api_key/google",
    model: "google/gemini-3.7-flash",
  });
  const agent = await createCubeAgent(home, workspace, config);
  const initial = await agent.getInstructions();
  assert.ok(Array.isArray(initial));
  assert.deepEqual(initial[1], { role: "system", content: soul });
  assert.match(JSON.stringify(initial[2]), /NOT an OS sandbox/);
  const ordinary = await agent.listTools();
  assert.ok(ordinary.edit_file && ordinary.write_file && !ordinary.apply_patch);
  updateCubeAgentModel(agent, "cube-api/openrouter/openai/gpt-5.5");
  const patchTools = await agent.listTools();
  assert.ok(patchTools.apply_patch && !patchTools.edit_file && !patchTools.write_file);
  assert.equal(patchTools.read_file, ordinary.read_file);
  assert.ok(!Object.keys(patchTools).some((name) => name.startsWith("mastra_workspace_") || name === "list_file"));
  updateCubeAgentModel(agent, "cube-oauth/anthropic/claude-sonnet");
  assert.ok((await agent.listTools()).edit_file);
  assert.doesNotMatch(JSON.stringify(initial), /Use pnpm|Use npm/);
  const loaded = agent.readInstructions();
  const text = formatAgentsContext(loaded.sources);
  assert.match(text, /Use pnpm/);
  assert.match(text, /Use npm. Answer in Vietnamese/);
  assert.match(text, /Check meaningful changes/);
  assert.doesNotMatch(text, /Unrelated rules/);
  const escapedProject = project.replaceAll("&", "&amp;");
  const projectMessages = loaded.sources.filter((source) => source.scope !== "global");
  assert.equal(projectMessages.length, 2);
  for (const message of projectMessages) {
    assert.equal(message.scope, project);
  }
  assert.ok(text.includes(`scope="${escapedProject}"`));
  assert.deepEqual(agent.instructionInfo, {
    soulCharacters: soul.length,
    agentsFiles: 3,
    agentsCharacters: "Use npm. Answer in Vietnamese.".length + "Use pnpm.".length + "Check meaningful changes.".length,
  });
  assert.match(text, /closest to the file or directory/);
  assert.match(text, /non-conflicting/);

  // Step summaries alone are not completed file-tool results.
  const processor = await agent.resolveProcessorById("cube-agents-md");
  assert.ok(processor?.processInputStep);
  await processor.processInputStep?.({
    messageList: new MessageList(),
    state: {},
    steps: [{ toolCalls: [{ input: { path: "unrelated" } }] }],
  } as any);
  assert.deepEqual(agent.readInstructions(), loaded);

  await writeFile(path.join(project, "AGENTS.md"), "Use pnpm. Run focused tests.");
  await unlink(home.getAgentsPath());
  assert.deepEqual(await agent.getInstructions(), initial);
  assert.deepEqual(agent.readInstructions(), loaded);
  await reloadCubeAgentInstructions(agent, home, workspace);
  const updated = await agent.getInstructions();
  assert.ok(Array.isArray(updated));
  assert.deepEqual(updated[0], initial[0]);
  assert.deepEqual(updated[1], initial[1]);
  assert.deepEqual(updated[2], initial[2]);
  assert.match(formatAgentsContext(agent.readInstructions().sources), /Run focused tests/);
  assert.doesNotMatch(formatAgentsContext(agent.readInstructions().sources), /Use npm/);
  const installed = agent.readInstructions();
  const counts = { ...agent.instructionInfo };
  await unlink(path.join(project, "AGENTS.md"));
  await mkdir(path.join(project, "AGENTS.md"));
  await assert.rejects(reloadCubeAgentInstructions(agent, home, workspace));
  assert.deepEqual(agent.readInstructions(), installed);
  assert.deepEqual(agent.instructionInfo, counts);
});

test("instructions omit missing AGENTS but surface unreadable instruction sources", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-instructions-errors-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = CubeHome({ cubeHome: path.join(root, "home") });
  const project = path.join(root, "project");
  await createBootstrap(home).run();
  await mkdir(project);
  await writeFile(home.getSoulPath(), "Cube behavior.");
  const workspace = CubeWorkspace(home, project);
  assert.equal((await loadInstructionSnapshot(home, workspace)).soul, "Cube behavior.");
  await ConfigStore(home).update((config) => ({ ...config, soul: { max_characters: 4 } }));
  await assert.rejects(loadInstructionSnapshot(home, workspace), /exceeds max length \(14\/4 characters\)/);
  await ConfigStore(home).update((config) => ({ ...config, soul: { max_characters: 20_000 } }));
  assert.equal(formatAgentsContext((await loadInstructionSnapshot(home, workspace)).sources), "");
  await mkdir(home.getAgentsPath());
  await assert.rejects(loadInstructionSnapshot(home, workspace));
  await rm(home.getAgentsPath(), { recursive: true });
  await mkdir(path.join(project, "AGENTS.md"));
  await assert.rejects(loadInstructionSnapshot(home, workspace));
});

test("restart refreshes saved instruction scopes within workspace boundaries", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-scoped-instructions-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = CubeHome({ cubeHome: path.join(root, "home") });
  const project = path.join(root, "project");
  await createBootstrap(home).run();
  for (const dir of ["a/deep", "b", ".agents", "unrelated"]) await mkdir(path.join(project, dir), { recursive: true });
  await writeFile(path.join(project, "AGENTS.md"), "root");
  await writeFile(path.join(project, ".agents/AGENTS.md"), "project config");
  await writeFile(path.join(project, "a/AGENTS.md"), "parent");
  await writeFile(path.join(project, "a/deep/AGENTS.md"), "nested");
  await writeFile(path.join(project, "b/AGENTS.md"), "sibling");
  await writeFile(path.join(project, "unrelated/AGENTS.md"), "not requested");
  const workspace = CubeWorkspace(home, project);
  const initial = await loadInstructionSnapshot(home, workspace);
  const scopes = ["a/deep", "a", "b"].map((dir) => path.join(project, dir));
  const sources = await workspace.readContextSources([
    ...scopes.map((dir) => path.join(dir, "AGENTS.md")),
    home.getAgentsPath(),
  ]);
  assert.deepEqual(sources.map((source) => source.content), ["nested", "parent", "sibling"]);
  await unlink(path.join(project, "a/deep/AGENTS.md"));
  await mkdir(path.join(project, "a/deep/AGENTS.md"));
  const saved = { ...initial, sources: [...sources, ...initial.sources], explored: [...initial.explored, ...scopes] };
  await assert.rejects(refreshInstructionSnapshot(workspace, initial, saved));
  await rm(path.join(project, "a/deep/AGENTS.md"), { recursive: true });
  await writeFile(path.join(project, "b/AGENTS.md"), "updated sibling");
  const refreshed = await refreshInstructionSnapshot(workspace, initial, saved);
  assert.deepEqual(refreshed.sources.map((source) => source.content), ["parent", "updated sibling", "root", "project config"]);
  assert.equal(refreshed.sources.filter((source) => source.content === "project config")[0]?.scope, project);
});

test("file-tool discovery caches scopes and misses, emitting signals without rewriting history", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = CubeHome({ cubeHome: path.join(root, "home") });
  const project = path.join(root, "project");
  await createBootstrap(home).run();
  for (const dir of ["src/deep", "src/empty", "sibling"]) {
    await mkdir(path.join(project, dir), { recursive: true });
  }
  await writeFile(path.join(project, "AGENTS.md"), "Root rules");
  await writeFile(path.join(project, "src/AGENTS.md"), "Parent rules");
  await writeFile(path.join(project, "src/deep/AGENTS.md"), "Deep rules");
  await writeFile(path.join(project, "sibling/AGENTS.md"), "Untouched rules");
  const workspace = CubeWorkspace(home, project);
  const agent = await createCubeAgent(home, workspace, RunnableConfigSchema.parse({
    ...await ConfigStore(home).read(), gateway: "api_key/google", model: "google/test",
  }));
  t.after(() => agent.disposeTools());
  const saved: unknown[] = [];
  agent.onInstructionsDiscovered = async (snapshot) => { saved.push(structuredClone(snapshot)); };
  const processor = await agent.resolveProcessorById("cube-agents-md");
  const list = new MessageList();
  const state = {};
  const sendSignal = async (input: Parameters<typeof createSignal>[0]) => {
    const signal = createSignal(input);
    list.addSignal(signal);
    return signal;
  };
  let callId = 0;
  const touch = async (target: string) => {
    list.add({ id: `message-${++callId}`, role: "assistant", createdAt: new Date(), content: {
      format: 2, parts: [{ type: "tool-invocation", toolInvocation: {
        state: "result", toolCallId: `call-${callId}`, toolName: "read_file",
        args: { path: target }, result: "source",
      } }],
    } }, "response");
    const before = structuredClone(list.get.all.db());
    await processor!.processInputStep!({ messageList: list, state, sendSignal } as any);
    assert.deepEqual(list.get.all.db().filter(message => before.some(previous => previous.id === message.id)), before);
  };
  await touch("src/deep/file.ts");
  assert.match(formatAgentsContext(agent.readInstructions().sources), /Deep rules[\s\S]*Parent rules/);
  assert.doesNotMatch(formatAgentsContext(agent.readInstructions().sources), /Untouched rules/);
  await touch("src/empty/missing.ts");
  const snapshot = agent.readInstructions();
  await writeFile(path.join(project, "src/deep/AGENTS.md"), "Changed deep");
  await writeFile(path.join(project, "src/empty/AGENTS.md"), "New rules");
  await touch("src/deep/other.ts");
  await touch("src/empty/other.ts");
  await touch(home.getAgentsPath());
  assert.deepEqual(agent.readInstructions(), snapshot);
  assert.equal(saved.length, 2);
  const discoveries = list.get.all.db().filter(message => message.role === "signal");
  assert.equal(discoveries.length, 2);
  assert.match(JSON.stringify(discoveries), /Deep rules|Parent rules/);
  assert.doesNotMatch(JSON.stringify(discoveries), /Changed deep|New rules|Untouched rules/);
  await reloadCubeAgentInstructions(agent, home, workspace, true);
  const refreshed = formatAgentsContext(agent.readInstructions().sources);
  assert.match(refreshed, /Changed deep/);
  assert.match(refreshed, /New rules/);
  assert.doesNotMatch(refreshed, /Untouched rules/);
  await reloadCubeAgentInstructions(agent, home, workspace);
  assert.doesNotMatch(formatAgentsContext(agent.readInstructions().sources), /Changed deep|New rules|Parent rules/);
});

test("maps OpenRouter reasoning effort into the provider request", () => {
  const config = buildModelConfig(
    "openrouter/poolside/laguna-xs-2.1:free",
    "high",
  );

  assert.deepEqual(config.providerOptions, {
    openrouter: { reasoning: { effort: "high", exclude: false } },
  });
});

test("enables OpenRouter reasoning when the catalog selects its default mode", () => {
  const config = buildModelConfig(
    "openrouter/poolside/laguna-s-2.1:free",
    "default",
  );

  assert.deepEqual(config.providerOptions, {
    openrouter: { reasoning: { enabled: true, exclude: false } },
  });
});

test("explicitly disables OpenRouter reasoning when none is selected", () => {
  const config = buildModelConfig(
    "openrouter/poolside/laguna-s-2.1:free",
    "none",
  );

  assert.deepEqual(config.providerOptions, {
    openrouter: { reasoning: { effort: "none", exclude: false } },
  });
});

test("maps Gemini 3 reasoning effort to thinkingLevel", () => {
  const config = buildModelConfig("google/gemini-3.7-flash", "high");

  assert.deepEqual(config.providerOptions, {
    google: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } },
  });
});

test("keeps Gemini 2.5 reasoning effort on numeric thinkingBudget", () => {
  const config = buildModelConfig("google/gemini-2.5-flash", "medium");

  assert.deepEqual(config.providerOptions, {
    google: { thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } },
  });
});

test("Gemini 3 never falls back to thinkingBudget or unsupported thinking levels", () => {
  for (const gateway of ["cube-api", "cube-oauth"]) {
    for (const effort of [undefined, "none", "default", "max", "xhigh", "ultra"]) {
      const config = buildModelConfig(`${gateway}/google/gemini-3.8-flash`, effort);
      assert.equal(config.providerOptions, undefined, `${gateway}: ${effort}`);
    }
    for (const effort of ["minimal", "low", "medium", "high"]) {
      assert.deepEqual(
        buildModelConfig(`${gateway}/google/gemini-3.8-flash`, effort).providerOptions,
        { google: { thinkingConfig: { thinkingLevel: effort, includeThoughts: true } } },
      );
    }
  }
  assert.deepEqual(buildModelConfig("google/gemini-2.5-flash", "none").providerOptions, {
    google: { thinkingConfig: { thinkingBudget: 0 } },
  });
  assert.equal(buildModelConfig("google/gemma-3-27b-it", "high").providerOptions, undefined);
});

test("requests a reasoning summary from OpenAI reasoning models", () => {
  const config = buildModelConfig("openai/gpt-5", "medium");

  assert.deepEqual(config.providerOptions, {
    openai: { reasoningEffort: "medium", reasoningSummary: "auto" },
  });
});

test("uses the installed Anthropic provider option shape for extended thinking", () => {
  const config = buildModelConfig("anthropic/claude-sonnet-4-5", "medium");

  assert.deepEqual(config.providerOptions, {
    anthropic: { thinking: { type: "enabled", budgetTokens: 8192 } },
  });
});

test("Cube agent registration routes logs through the composition file logger", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-agent-logger-test-"));
  const home = CubeHome({ cubeHome: path.join(root, ".cube"), userHome: root });
  t.mock.method(home, "getMemoryDbPath", () => ":memory:");
  await home.ensure();
  await createBootstrap(home).run();
  const workspace = CubeWorkspace(home, root);
  const config = RunnableConfigSchema.parse({
    ...await ConfigStore(home).read(),
    gateway: "api_key/google",
    model: "google/gemini-3.7-flash",
  });

  let composition: Awaited<ReturnType<typeof createCubeMastra>> | undefined;
  const terminal = t.mock.method(console, "error", () => {});
  try {
    composition = await createCubeMastra(home, workspace, config);
    runWithCubeLogContext({ threadId: "registered-agent" }, () =>
      composition!.agent.logger.error("Registered Cube agent error", { apiKey: "registration-secret" }));
    await composition.shutdown();
    const log = await readFile(path.join(home.getLogDir(), "threads", "registered-agent.log"), "utf8");
    assert.match(log, /Registered Cube agent error/);
    assert.match(log, /registered-agent/);
    assert.doesNotMatch(log, /registration-secret/);
    assert.equal(terminal.mock.callCount(), 0);
  } finally {
    await composition?.shutdown();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

test("keeps local models as Mastra router IDs instead of constructing Ollama directly", () => {
  const routerId = "cube-local/ollama/qwen2.5:7b";
  const config = buildModelConfig(routerId, "none");

  assert.equal(config.model, routerId);
  assert.equal(typeof config.model, "string");
});

test("derives provider options from canonical IDs behind a Cube gateway prefix", () => {
  const config = buildModelConfig(
    "cube-api/google/gemini-3.7-flash",
    "high",
  );

  assert.equal(config.model, "cube-api/google/gemini-3.7-flash");
  assert.deepEqual(config.providerOptions, {
    google: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } },
  });
});

test("loads global skills outside the project without crossing the workspace filesystem boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-agent-skills-test-"));
  const home = CubeHome({ cubeHome: path.join(root, "home", ".cube") });
  const projectRoot = path.join(root, "project");
  const globalSkillDir = path.join(home.getSkillDir(), "global-test");
  const projectSkillDir = path.join(projectRoot, ".agents", "skills", "project-test");
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;

  try {
    await home.ensure();
    await createBootstrap(home).run();
    await mkdir(globalSkillDir, { recursive: true });
    await mkdir(projectSkillDir, { recursive: true });
    await writeFile(
      path.join(globalSkillDir, "SKILL.md"),
      "---\nname: global-test\ndescription: Global test skill\n---\n\nGlobal instructions.\n",
      "utf8",
    );
    await writeFile(
      path.join(projectSkillDir, "SKILL.md"),
      "---\nname: project-test\ndescription: Project test skill\n---\n\nProject instructions.\n",
      "utf8",
    );

    const workspace = CubeWorkspace(home, projectRoot);
    const config = RunnableConfigSchema.parse({
      ...await ConfigStore(home).read(),
      gateway: "api_key/google",
      model: "google/gemini-3.7-flash",
    });
    console.warn = (...args: unknown[]) => warnings.push(args);

    const agent = await createCubeAgent(home, workspace, config);
    const skills = await agent.listSkills();

    assert.deepEqual(
      skills.filter(skill => ["global-test", "project-test"].includes(skill.name)).map((skill) => skill.name).sort(),
      ["global-test", "project-test"],
    );
    assert.equal(
      warnings.some((args) => String(args[0]).includes("Cannot access skills path")),
      false,
    );
  } finally {
    console.warn = originalWarn;
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
