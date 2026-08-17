import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createCubeWorkspace } from "../src/index.js";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const bootstrapFiles = ["config.yaml", "SOUL.md", "workspace.json", "mcp.json"];

const createTestWorkspace = (context: TestContext) => {
  const home = mkdtempSync(path.join(packageDirectory, ".test-cube-home-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, workspace: createCubeWorkspace({ home }) };
};

test("initialization creates the four bootstrap files and runtime directories", (context) => {
  const { home, workspace } = createTestWorkspace(context);

  workspace.initialize();

  for (const fileName of bootstrapFiles) {
    assert.equal(existsSync(path.join(home, fileName)), true);
  }
  assert.equal(existsSync(path.join(home, "memories")), true);
  assert.equal(existsSync(path.join(home, "logs")), true);
});

test("initialization does not create future-phase skills or plugins directories", (context) => {
  const { home, workspace } = createTestWorkspace(context);

  workspace.initialize();

  assert.equal(existsSync(path.join(home, "skills")), false);
  assert.equal(existsSync(path.join(home, "plugins")), false);
});

test("reinitialization preserves user edits to every bootstrap file", (context) => {
  const { home, workspace } = createTestWorkspace(context);
  workspace.initialize();
  const edits = new Map(bootstrapFiles.map((fileName, index) => [
    fileName,
    `user edit ${index}\n`,
  ]));
  for (const [fileName, content] of edits) {
    writeFileSync(path.join(home, fileName), content, "utf8");
  }

  workspace.initialize();

  for (const [fileName, content] of edits) {
    assert.equal(readFileSync(path.join(home, fileName), "utf8"), content);
  }
});

test("invalid user config falls back for the run without changing the file", (context) => {
  const { home, workspace } = createTestWorkspace(context);
  workspace.initialize();
  const invalidConfig = "version: nope\nmodel: broken\n";
  const configPath = path.join(home, "config.yaml");
  writeFileSync(configPath, invalidConfig, "utf8");

  const result = workspace.config.read();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.version, 1);
  assert.deepEqual(result.value.model_config, {});
  assert.equal(result.value.soul.max_characters, 20_000);
  assert.match(result.warning ?? "", /using packaged defaults/i);
  assert.equal(readFileSync(configPath, "utf8"), invalidConfig);
});

test("invalid model config falls back without rewriting the user file", (context) => {
  const { home, workspace } = createTestWorkspace(context);
  workspace.initialize();
  const configPath = path.join(home, "config.yaml");
  const initial = readFileSync(configPath, "utf8");
  const invalidConfig = initial.replace(
    "model_config: {}",
    "model_config:\n  reasoning_effort: impossible",
  );
  writeFileSync(configPath, invalidConfig, "utf8");

  const result = workspace.config.read();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.model_config, {});
  assert.match(result.warning ?? "", /using packaged defaults/i);
  assert.equal(readFileSync(configPath, "utf8"), invalidConfig);
});

test("valid config writes are validated and persisted", (context) => {
  const { workspace } = createTestWorkspace(context);
  const initial = workspace.config.read();
  assert.equal(initial.ok, true);
  if (!initial.ok) return;

  const writeResult = workspace.config.write({
    ...initial.value,
    model: "google/gemini-3-flash",
    model_config: { reasoning_effort: "high" },
  });
  const reread = workspace.config.read();

  assert.equal(writeResult.ok, true);
  assert.equal(reread.ok, true);
  if (!reread.ok) return;
  assert.equal(reread.value.model, "google/gemini-3-flash");
  assert.deepEqual(reread.value.model_config, { reasoning_effort: "high" });
});

test("successful config writes leave no temporary file", (context) => {
  const { home, workspace } = createTestWorkspace(context);
  const initial = workspace.config.read();
  assert.equal(initial.ok, true);
  if (!initial.ok) return;

  const result = workspace.config.write(initial.value);

  assert.equal(result.ok, true);
  assert.equal(existsSync(path.join(home, "config.yaml.tmp")), false);
});

test("failed atomic config writes preserve the original config", (context) => {
  const { home, workspace } = createTestWorkspace(context);
  workspace.initialize();
  const configPath = path.join(home, "config.yaml");
  const original = readFileSync(configPath, "utf8");
  mkdirSync(path.join(home, "config.yaml.tmp"));
  const initial = workspace.config.read();
  assert.equal(initial.ok, true);
  if (!initial.ok) return;

  const result = workspace.config.write({
    ...initial.value,
    model: "openai/gpt-5.1",
  });

  assert.equal(result.ok, false);
  assert.equal(readFileSync(configPath, "utf8"), original);
});

test("a missing SOUL file is recreated from the packaged template", (context) => {
  const { home, workspace } = createTestWorkspace(context);
  workspace.initialize();
  const soulPath = path.join(home, "SOUL.md");
  rmSync(soulPath);

  const result = workspace.soul.snapshot();

  assert.equal(result.ok, true);
  assert.equal(existsSync(soulPath), true);
  if (result.ok) assert.equal(result.value, readFileSync(soulPath, "utf8"));
});

test("whitespace SOUL uses the packaged fallback without rewriting the user file", (context) => {
  const { home, workspace } = createTestWorkspace(context);
  workspace.initialize();
  const soulPath = path.join(home, "SOUL.md");
  const whitespace = "  \n\t";
  writeFileSync(soulPath, whitespace, "utf8");

  const result = workspace.soul.snapshot();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.value, /You are Cube/);
  assert.match(result.warning ?? "", /using packaged instructions/i);
  assert.equal(readFileSync(soulPath, "utf8"), whitespace);
});

test("SOUL over the Unicode character limit returns an error without truncating", (context) => {
  const { home, workspace } = createTestWorkspace(context);
  workspace.initialize();
  const soulPath = path.join(home, "SOUL.md");
  const oversizedSoul = "a".repeat(20_001);
  writeFileSync(soulPath, oversizedSoul, "utf8");

  const result = workspace.soul.snapshot();

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /20,001 characters|20001 characters/);
  assert.equal(readFileSync(soulPath, "utf8"), oversizedSoul);
});

test("agent runtime exposes only the expected memory and thread log paths", (context) => {
  const { home, workspace } = createTestWorkspace(context);

  assert.deepEqual(Object.keys(workspace.agentRuntime).sort(), [
    "memoryDatabase",
    "threadLog",
  ]);
  assert.equal(
    workspace.agentRuntime.memoryDatabase,
    path.join(home, "memories", "memory.sqlite"),
  );
  assert.equal(
    workspace.agentRuntime.threadLog("thread-42"),
    path.join(home, "logs", "agent-thread-42.json"),
  );
});
