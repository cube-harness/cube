import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CubeHome, CubeWorkspace, ConfigStore, createBootstrap, RunnableConfigSchema } from "@cube/workspace";
import { SpanType } from "@mastra/core/observability";
import { MastraStorageExporter } from "@mastra/observability";
import { Agent } from "@mastra/core/agent";
import { Session } from "@mastra/core/agent-controller";
import { WorkingIndicator } from "../../cube-tui/src/components/working-indicator.js";
import { createCubeMastra, DrainingStorageExporter } from "../src/bootstrap.js";

test("terminal session events clear foreground memory indicators without stopping background buffering", () => {
  const session = new Session({ resourceId: "test", id: "test", ownerId: "test" });
  let timers = 0;
  const indicator = new WorkingIndicator({ requestRender() {} } as never, {
    schedule: () => { timers++; return { unref() {} } as NodeJS.Timeout; },
    cancelSchedule: () => { timers--; },
  });
  session.subscribe(event => {
    if (event.type === "display_state_changed") indicator.sync(event.displayState, false);
  });
  try {
    for (const reason of ["complete", "error", "aborted", "suspended"] as const) {
      for (const phase of ["observation", "reflection"] as const) {
        session.emit({ type: "agent_start" });
        session.emit(phase === "observation"
          ? { type: "om_observation_start", cycleId: "test", operationType: phase, tokensToObserve: 100 }
          : { type: "om_reflection_start", cycleId: "test", tokensToReflect: 100 });
        assert.equal(indicator.isActive(), true);
        session.emit({ type: "agent_end", reason });
        assert.equal(indicator.isActive(), false);
        assert.equal(timers, 0);
        assert.equal(session.displayState.get().omProgress.status, "idle");
        assert.equal(session.displayState.get().omProgress.cycleId, undefined);
        session.emit({ type: "agent_start" });
        assert.doesNotMatch(indicator.render(100).join("\n"), /Observing|Reflecting/);
        session.emit({ type: "agent_end", reason: "complete" });
      }
    }
    session.emit({ type: "agent_start" });
    session.emit({ type: "om_buffering_start", cycleId: "background", operationType: "observation", tokensToBuffer: 100 });
    session.emit({ type: "agent_end", reason: "complete" });
    assert.equal(indicator.isActive(), true);
    session.emit({ type: "om_buffering_end", cycleId: "background", operationType: "observation", tokensBuffered: 100, bufferedTokens: 100 });
    assert.equal(indicator.isActive(), false);
    assert.equal(timers, 0);
  } finally {
    indicator.stop();
  }
});

test("exporter shutdown waits for a tracing write already in flight", async (context) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const write = context.mock.method(MastraStorageExporter.prototype, "_exportTracingEvent", () => pending);
  let closed = false;
  context.mock.method(MastraStorageExporter.prototype, "shutdown", async () => { closed = true; });
  const exporter = new DrainingStorageExporter();
  const flushing = exporter._exportTracingEvent({} as Parameters<MastraStorageExporter["_exportTracingEvent"]>[0]);
  const closing = exporter.shutdown();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await Promise.all([flushing, closing]);
  assert.equal(closed, true);
  assert.equal(exporter.shutdown(), closing);
  await exporter.exportTracingEvent({} as Parameters<MastraStorageExporter["exportTracingEvent"]>[0]);
  assert.equal(write.mock.callCount(), 1);
});

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
      instance?.startSpan({ name: "shutdown-smoke", type: SpanType.GENERIC }).end();
      const storage = composition.mastra.getStorage()!;
      const close = storage.close!.bind(storage);
      const shutdown = obs.shutdown.bind(obs);
      const order: string[] = [];
      obs.shutdown = async () => { order.push("observability"); await shutdown(); };
      storage.close = async () => { order.push("storage"); await close(); };
      await composition.shutdown();
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
