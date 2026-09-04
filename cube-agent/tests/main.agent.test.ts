import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { ConfigStore, CubeHome, Workspace, createBootstrap } from "@cube/workspace";
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
  const workspace = Workspace(home, root);
  const childLogger = { marker: "cube-file-logger" };
  const logger = { child: () => childLogger };
  const config = await ConfigStore(home).read();

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
