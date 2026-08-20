import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CubeHome, createBootstrap, ConfigStore } from "@cube/workspace";
import { createUsageCommandHandler } from "../src/commands/usage.command.js";

const createTestHome = async () => {
  const tmp = await mkdtemp(join(tmpdir(), "cube-usage-test-"));
  const home = CubeHome(tmp);
  await home.ensure();
  await createBootstrap(home).run();
  return { home, tmp };
};

test("UsageCommand displays token statistics, active turn tokens, and thread title in UsageBox", async () => {
  const { home, tmp } = await createTestHome();
  try {
    await ConfigStore(home).update((curr) => ({
      ...curr,
      model: "google/gemini-2.5-flash",
      model_config: { reasoning_effort: "high" },
    }));

    let output = "";
    const session = {
      thread: {
        getId: () => "thread-usage-123",
        list: async () => [
          { id: "thread-usage-123", title: "Refactor Authentication" },
        ],
      },
      getTokenUsage: () => ({
        promptTokens: 40016,
        completionTokens: 1840,
        reasoningTokens: 538,
        totalTokens: 41856,
        cachedInputTokens: 4096,
        cacheCreationInputTokens: 1024,
        raw: {
          inputTokens: { total: 6127 },
        },
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

    assert.ok(output.includes("Usage & Context Statistics"));
    assert.ok(output.includes("google/gemini-2.5-flash (high)"));
    assert.ok(output.includes("Capabilities"));
    assert.ok(output.includes("Context Window"));
    assert.ok(output.includes("6,127 /"));
    assert.ok(output.includes("40,016 (Active Turn: 6,127)"));
    assert.ok(output.includes("1,840"));
    assert.ok(output.includes("538"));
    assert.ok(output.includes("4,096 (Read: 4,096, Write: 1,024)"));
    assert.ok(output.includes("41,856"));
    assert.ok(output.includes("Refactor Authentication"));
    assert.ok(output.includes("thread-usage-123"));
    assert.ok(!output.includes("`thread-usage-123`"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
