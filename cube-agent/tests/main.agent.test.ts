import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  ConfigStore,
  CubeHome,
  CubeWorkspace,
  RunnableConfigSchema,
  createBootstrap,
} from "@cube/workspace";
import { buildModelConfig, createCubeAgent } from "../src/agents/main.agent.js";

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

test("createCubeAgent installs the Cube logger before the agent is registered with Mastra", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-agent-logger-test-"));
  const home = CubeHome({ cubeHome: path.join(root, ".cube") });
  await home.ensure();
  await createBootstrap(home).run();
  const workspace = CubeWorkspace(home, root);
  const childLogger = { marker: "cube-file-logger" };
  const logger = { child: () => childLogger };
  const config = RunnableConfigSchema.parse({
    ...await ConfigStore(home).read(),
    gateway: "api_key/google",
    model: "google/gemini-3.7-flash",
  });

  try {
    const agent = await createCubeAgent(home, workspace, config, logger as any);
    assert.equal(agent.logger, childLogger);
  } finally {
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
      skills.map((skill) => skill.name).sort(),
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
