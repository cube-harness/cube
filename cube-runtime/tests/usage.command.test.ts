import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CubeHome, createBootstrap, ConfigStore } from "@cube/workspace";
import { ActionDispatcher } from "../src/dispatcher.js";
import { createUsageCommandHandler } from "../src/commands/usage.command.js";
import type { CubeEvent } from "../src/contracts/events.contract.js";

const createTestHome = async () => {
  const tmp = await mkdtemp(join(tmpdir(), "cube-usage-test-"));
  const home = CubeHome(tmp);
  await home.ensure();
  await createBootstrap(home).run();
  return { home, tmp };
};

test("UsageCommand computes metrics and emits usage:metrics event", async () => {
  const { home, tmp } = await createTestHome();
  try {
    await ConfigStore(home).update((curr) => ({
      ...curr,
      model: "google/gemini-2.5-flash",
      model_config: { reasoning_effort: "high" },
    }));

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

    const dispatcher = new ActionDispatcher();
    const events: CubeEvent[] = [];
    dispatcher.subscribe((e) => events.push(e));

    const handler = createUsageCommandHandler({
      home,
      session: session as any,
      dispatcher,
    });

    await handler("");

    const usageEvent = events.find((e) => e.type === "usage:metrics") as any;
    assert.ok(usageEvent);
    assert.equal(usageEvent.metrics.model, "google/gemini-2.5-flash");
    assert.equal(usageEvent.metrics.reasoningEffort, "high");
    assert.equal(usageEvent.metrics.activeTurnTokens, 6127);
    assert.equal(usageEvent.metrics.promptTokens, 40016);
    assert.equal(usageEvent.metrics.completionTokens, 1840);
    assert.equal(usageEvent.metrics.reasoningTokens, 538);
    assert.equal(usageEvent.metrics.totalTokens, 41856);
    assert.equal(usageEvent.metrics.threadTitle, "Refactor Authentication");
    assert.equal(usageEvent.metrics.threadId, "thread-usage-123");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
