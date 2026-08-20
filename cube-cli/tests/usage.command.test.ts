import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CubeHome, ConfigStore, createBootstrap } from "@cube/workspace";
import { createUsageCommandHandler } from "../src/commands/usage.command.js";

const createTestHome = async () => {
  const tmp = await mkdtemp(join(tmpdir(), "cube-usage-test-"));
  const home = CubeHome(tmp);
  await home.ensure();
  await createBootstrap(home).run();
  return { home, tmp };
};

test("UsageCommand displays token statistics and context window progress bar", async () => {
  const { home, tmp } = await createTestHome();
  try {
    let output = "";
    const session = {
      thread: {
        getId: () => "thread-usage-123",
      },
      getTokenUsage: () => ({
        promptTokens: 12580,
        completionTokens: 1840,
        totalTokens: 14420,
        cachedInputTokens: 4096,
      }),
    };

    const handler = createUsageCommandHandler({
      home,
      session: session as any,
      showMessage: (msg) => {
        output = msg;
      },
    });

    await handler("");

    assert.ok(output.includes("### 📊 Token & Context Window Usage"));
    assert.ok(output.includes("• Active Model:"));
    assert.ok(output.includes("• Context Window:"));
    assert.ok(output.includes("12,580"));
    assert.ok(output.includes("1,840"));
    assert.ok(output.includes("4,096"));
    assert.ok(output.includes("14,420"));
    assert.ok(output.includes("thread-usage-123"));
    assert.ok(output.includes("["));
    assert.ok(output.includes("]"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
