import assert from "node:assert/strict";
import test from "node:test";
import { MemoryService } from "../../cube-runtime/src/services/memory.service.js";
import { Agent } from "@mastra/core/agent";
import { AgentController } from "@mastra/core/agent-controller";
import { InMemoryStore } from "@mastra/core/storage";
import { Mastra } from "@mastra/core";
import { Memory } from "@mastra/memory";
import { MockLanguageModelV3 } from "ai/test";

test("native queued turns wait for manual cancellation cleanup and the awaited end hook", { timeout: 30_000 }, async () => {
  let requests = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    requests++;
    return { stream: new ReadableStream({ start(controller) {
      for (const part of [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "a" }, { type: "text-delta", id: "a", delta: "done" }, { type: "text-end", id: "a" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        } },
      ]) controller.enqueue(part);
      controller.close();
    } }) };
  } });
  const controller = new AgentController({ id: "queue-test", agent: new Agent({ id: "queue-agent", name: "Queue", instructions: "Test", model }),
    memory: new Memory({ options: { generateTitle: false, observationalMemory: false } }),
    modes: [{ id: "default", name: "Default", metadata: { default: true } }],
  });
  const mastra = new Mastra({ storage: new InMemoryStore(), agentControllers: { controller }, logger: false });
  const session = await controller.createSession({ resourceId: "workspace" });
  const started = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const pruneStarted = Promise.withResolvers<void>();
  const pruneCommit = Promise.withResolvers<void>();
  const allDone = Promise.withResolvers<void>();
  const errors: unknown[] = [];
  let ended = 0;
  session.subscribe((event) => {
    if (event.type === "error") errors.push(event);
    if (event.type === "agent_end" && ++ended === 2) allDone.resolve();
  });
  const stop = session.onBeforeAgentEnd(async () => {
    if (requests === 1) { pruneStarted.resolve(); await pruneCommit.promise; }
  });
  const service = new MemoryService(session, {
    isCompacting: () => false, cancel() {}, drain: async () => {},
    compactManual: async ({ signal }) => {
      started.resolve();
      await cleanup.promise;
      signal.throwIfAborted();
      return { status: "skipped", reason: "unused" };
    },
  });
  try {
    await session.thread.create({ id: "queue-thread" });
    const pending = service.compact();
    const rejected = assert.rejects(pending, /abort/i);
    await started.promise;
    await session.followUp({ content: "first queued" });
    assert.equal(session.followUps.count(), 1);
    service.cancel();
    assert.equal(session.run.isRunning(), true);
    assert.equal(requests, 0);
    cleanup.resolve();
    await pruneStarted.promise;
    await session.followUp({ content: "second queued" });
    assert.equal(requests, 1);
    assert.equal(session.followUps.count(), 1);
    pruneCommit.resolve();
    await allDone.promise;
    await rejected;
    assert.equal(requests, 2);
    assert.equal(session.followUps.count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    cleanup.resolve(); pruneCommit.resolve(); stop();
    await service.shutdown();
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
    await mastra.shutdown();
  }
});
