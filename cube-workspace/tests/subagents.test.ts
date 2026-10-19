import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HomeManager } from "../src/home-manager.js";
import { ConfigSchema } from "../src/schemas/config.schema.js";
import { loadSubagentDefinitions, type SubagentDefinition } from "../src/subagents-manager.js";

test("subagent defaults and partial overrides reject unsafe scheduling settings", () => {
  assert.deepEqual(ConfigSchema.parse({}).subagents, { concurrency: 2, model: "inherit", timeout_ms: 0 });
  assert.deepEqual(ConfigSchema.parse({ subagents: { concurrency: 3 } }).subagents,
    { concurrency: 3, model: "inherit", timeout_ms: 0 });
  for (const subagents of [{ concurrency: 0 }, { concurrency: 33 }, { timeout_ms: -1 },
    { timeout_ms: Number.MAX_SAFE_INTEGER + 1 }, { isolation: "worktree" }]) {
    assert.equal(ConfigSchema.safeParse({ subagents }).success, false);
  }
  assert.deepEqual(ConfigSchema.parse({ subagents: { model: "openai/test", timeout_ms: 100 } }).subagents,
    { concurrency: 2, model: "openai/test", timeout_ms: 100 });
  assert.equal(ConfigSchema.parse({ subagents: { reasoning_effort: "high" } }).subagents.reasoning_effort, "high");
});

test("role snapshots use whole project overrides and never fall back from invalid winners", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cube-roles-"));
  const home = new HomeManager({ cubeHome: path.join(temp, "home") });
  const project = path.join(temp, "project");
  const globalDir = path.join(home.getRoot(), "agents");
  const projectDir = path.join(project, ".cube", "agents");
  const communityDir = path.join(project, ".agents", "agents");
  const builtin: SubagentDefinition[] = [{ name: "worker", description: "builtin", instructions: "work", source: "builtin" }];
  try {
    assert.deepEqual(await loadSubagentDefinitions(home, project, builtin), { agents: builtin, errors: [] });
    await mkdir(globalDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await mkdir(communityDir, { recursive: true });
    await writeFile(path.join(globalDir, "review.md"), "---\ndescription: global\nmodel: openai/global\n---\nglobal body");
    await writeFile(path.join(communityDir, "review.md"), "---\ndescription: project community\n---\ncommunity body");
    const community = (await loadSubagentDefinitions(home, project, builtin)).agents.find(agent => agent.name === "review")!;
    assert.equal(community.instructions, "community body");
    assert.equal(community.source, "project");
    assert.equal(community.path, path.join(communityDir, "review.md"));
    await writeFile(path.join(projectDir, "review.md"), "---\ndescription: project\n---\nproject body");
    const snapshot = await loadSubagentDefinitions(home, project, builtin);
    assert.equal(snapshot.agents.find(agent => agent.name === "review")?.instructions, "project body");
    assert.equal(snapshot.agents.find(agent => agent.name === "review")?.model, undefined);
    assert.equal(snapshot.agents.find(agent => agent.name === "review")?.source, "project");
    await writeFile(path.join(projectDir, "review.md"), `---
description: scoped worker
model: openai/test
reasoning_effort: high
tools: [read_file, execute_command]
disallowedTools: [execute_command]
skills: [review]
mcpServers: [docs]
isolation: worktree
---
scoped body`);
    const scoped = (await loadSubagentDefinitions(home, project, builtin)).agents.find(agent => agent.name === "review")!;
    assert.equal(scoped.model, "openai/test");
    assert.equal(scoped.reasoning_effort, "high");
    assert.deepEqual(scoped.tools, ["read_file", "execute_command"]);
    assert.deepEqual(scoped.disallowedTools, ["execute_command"]);
    assert.deepEqual(scoped.skills, ["review"]);
    assert.deepEqual(scoped.mcpServers, ["docs"]);
    assert.equal(scoped.isolation, "worktree");
    await writeFile(path.join(projectDir, "review.md"), "---\ndescription: broken\nunknown: true\n---\nbody");
    const invalid = await loadSubagentDefinitions(home, project, builtin);
    assert.equal(invalid.agents.length, 1);
    assert.equal(invalid.errors[0]?.name, "review");
    assert.equal(snapshot.agents.find(agent => agent.name === "review")?.instructions, "project body");
    for (const content of ["no metadata", "---\ndescription: missing body\n---\n",
      "---\ndescription: [invalid\n---\nbody", "---\ndescription: valid\ntools: [read_file, read_file]\n---\nbody"]) {
      await writeFile(path.join(projectDir, "review.md"), content);
      assert.equal((await loadSubagentDefinitions(home, project, builtin)).agents.length, 1);
    }
    for (const field of ["tools", "disallowedTools", "skills", "mcpServers"]) {
      for (const value of ["[same, same]", "['']", "not-an-array"]) {
        await writeFile(path.join(projectDir, "review.md"), `---\ndescription: scoped\n${field}: ${value}\n---\nbody`);
        assert.equal((await loadSubagentDefinitions(home, project, builtin)).agents.length, 1);
      }
    }
    await writeFile(path.join(projectDir, "review.md"), "---\ndescription: scoped\nisolation: sandbox\n---\nbody");
    assert.equal((await loadSubagentDefinitions(home, project, builtin)).agents.length, 1);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("reserved builtin Markdown never replaces or hides the builtin", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cube-reserved-"));
  const home = new HomeManager({ cubeHome: path.join(temp, "home") });
  const directory = path.join(temp, "project", ".agents", "agents");
  const builtin: SubagentDefinition[] = [
    { name: "worker", description: "work", instructions: "fixed worker", source: "builtin" },
    { name: "explore", description: "explore", instructions: "fixed explore", source: "builtin", disallowedTools: ["write_file"] },
  ];
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "worker.md"), "---\ndescription: override\n---\nwrong instruction");
    await writeFile(path.join(directory, "explore.md"), "---\ndescription: override\ntools: [write_file]\n---\nwrite files");
    const loaded = await loadSubagentDefinitions(home, path.join(temp, "project"), builtin);
    assert.deepEqual(loaded.agents, [builtin[1], builtin[0]]);
    assert.equal(loaded.errors.length, 2);
    assert.ok(loaded.errors.every(error => /reserved/i.test(error.message)));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
