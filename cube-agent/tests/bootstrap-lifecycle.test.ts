import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CubeHome, CubeWorkspace, ConfigStore, createBootstrap, RunnableConfigSchema } from "@cube/workspace";
import { SpanType } from "@mastra/core/observability";
import { Agent } from "@mastra/core/agent";
import { createCubeMastra } from "../src/bootstrap.js";

test("telemetry respects config and drains spans before closing storage", { timeout: 30_000 }, async (context) => {
  for (const telemetry of [false, true]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "cube-lifecycle-"));
    const home = CubeHome({ cubeHome: path.join(root, ".cube") });
    // Exercise real SQLite lifecycle without Windows file-lock teardown delays.
    context.mock.method(home, "getMemoryDbPath", () => ":memory:");
    let composition: Awaited<ReturnType<typeof createCubeMastra>> | undefined;
    try {
      await createBootstrap(home).run();
      const config = RunnableConfigSchema.parse({ ...await ConfigStore(home).read(),
        gateway: "api_key/google", model: "google/gemini-test", telemetry });
      composition = await createCubeMastra(home, CubeWorkspace(home, root), config);
      await composition.mastra.getStorage()!.init();
      const obs = composition.mastra.observability;
      const instance = obs.getDefaultInstance();
      assert.equal(Boolean(instance), telemetry);
      const storage = composition.mastra.getStorage()!;
      const release = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      if (telemetry) {
        const tracing = await storage.getStore("observability");
        assert.ok(tracing);
        const write = tracing.batchCreateSpans.bind(tracing);
        context.mock.method(tracing, "batchCreateSpans", async (args) => {
          started.resolve();
          await release.promise;
          await write(args);
        });
        instance!.startSpan({ name: "shutdown-smoke", type: SpanType.GENERIC }).end();
        await started.promise;
      }
      const close = storage.close!.bind(storage);
      const shutdown = obs.shutdown.bind(obs);
      const order: string[] = [];
      obs.shutdown = async () => { order.push("observability"); await shutdown(); };
      storage.close = async () => { order.push("storage"); await close(); };
      const closing = composition.shutdown();
      try {
        await new Promise((resolve) => setImmediate(resolve));
        if (telemetry) assert.equal(order.includes("storage"), false);
      } finally {
        release.resolve();
      }
      await closing;
      assert.equal(order[0], "observability");
      assert.ok(order.indexOf("storage") > 0);
      assert.equal(order.filter((event) => event === "storage").length, 1);
      await composition.shutdown();
      assert.equal(order.filter((event) => event === "storage").length, 1);
    } finally {
      await composition?.shutdown();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

test("composition keeps storage open until the native stream finishes cleanup", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-stream-drain-"));
  const home = CubeHome({ cubeHome: root });
  context.mock.method(home, "getMemoryDbPath", () => ":memory:");
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  context.mock.method(Agent.prototype, "stream", async () => ({ consumeStream: () => finished }));
  let composition: Awaited<ReturnType<typeof createCubeMastra>> | undefined;
  try {
    await createBootstrap(home).run();
    const config = RunnableConfigSchema.parse({ ...await ConfigStore(home).read(),
      gateway: "api_key/google", model: "google/gemini-test" });
    composition = await createCubeMastra(home, CubeWorkspace(home, root), config);
    await composition.agent.stream("test");
    let closed = false;
    const storage = composition.mastra.getStorage()!;
    const close = storage.close!.bind(storage);
    storage.close = async () => { closed = true; await close(); };
    const shutdown = composition.shutdown();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    finish();
    await shutdown;
    assert.equal(closed, true);
  } finally {
    finish();
    await composition?.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("child result persists once without waking an idle parent or recreating a deleted thread", { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-result-delivery-"));
  const home = CubeHome({ cubeHome: root, userHome: root });
  t.mock.method(home, "getMemoryDbPath", () => ":memory:");
  let composition: Awaited<ReturnType<typeof createCubeMastra>> | undefined;
  try {
    await createBootstrap(home).run();
    const config = RunnableConfigSchema.parse({ gateway: "api_key/google", model: "google/test" });
    composition = await createCubeMastra(home, CubeWorkspace(home, root), config);
    const session = await composition.controller.createSession({ resourceId: root });
    await session.thread.create({ id: "result-parent" });
    const record = {
      id: "result-child", parentThreadId: "result-parent", projectRoot: root,
      agent: "worker", error: "Child failed before execution", pendingDelivery: "child-result",
    };
    await composition.deliverSubagentResult(record, true);
    await composition.deliverSubagentResult(record, true);
    const storage = (await composition.mastra.getStorage()!.getStore("memory"))!;
    const saved = await storage.listMessagesById({ messageIds: ["child-result"] });
    assert.equal(saved.messages.length, 1);
    assert.equal(saved.messages[0]!.threadId, "result-parent");
    assert.match(JSON.stringify(saved.messages), /Child failed before execution/);
    await composition.deliverSubagentResult({ ...record, status: "cancelled",
      history: { threadId: "cancelled-native-thread", resourceId: "private-resource", runId: "cancelled-native-run" },
      error: "Subagent cancelled", pendingDelivery: "cancelled-child-result" }, false);
    const cancelled = await storage.listMessagesById({ messageIds: ["cancelled-child-result"] });
    const cancelledText = JSON.stringify(cancelled.messages);
    assert.match(cancelledText, /cancelled-native-thread/);
    assert.match(cancelledText, /cancelled-native-run/);
    assert.match(cancelledText, /\\"status\\":\\"cancelled\\"/);
    assert.equal(session.run.isRunning(), false);
    await session.thread.delete({ threadId: "result-parent" });
    await composition.deliverSubagentResult({ ...record, pendingDelivery: "late-child-result" }, true);
    assert.equal(await storage.getThreadById({ threadId: "result-parent" }), null);
    assert.equal((await storage.listMessagesById({ messageIds: ["late-child-result"] })).messages.length, 0);
  } finally {
    await composition?.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
