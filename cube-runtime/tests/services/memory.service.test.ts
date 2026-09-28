import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "@cube/agent";
import { MemoryService } from "../../src/services/memory.service.js";

test("manual compact holds native queue ownership until cancellation settles", async () => {
  let running = false, drained = 0, calls = 0;
  let thread: string | null = null;
  const session = {
    thread: { getId: () => thread },
    run: { isRunning: () => running, ensureAbortController: () => { running = true; return new AbortController(); }, reset: () => { running = false; } },
    approval: { isArmed: () => false }, suspensions: { hasPending: () => false },
    drainFollowUpQueue: async () => { drained++; },
  } as unknown as Session;
  const service = new MemoryService(session, {
    isCompacting: () => false, cancel() {}, drain: async () => {},
    compactManual: async ({ signal }) => {
      calls++;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      signal.throwIfAborted();
      return { status: "skipped", reason: "unused" };
    },
  });
  await assert.rejects(service.compact(), /No active thread/);
  thread = "thread";
  const pending = service.compact();
  assert.equal(running, true);
  await assert.rejects(service.compact(), /active turn/);
  assert.equal(calls, 1);
  service.cancel();
  assert.equal(service.isManual(), true);
  assert.equal(running, true);
  await assert.rejects(pending, /abort/i);
  assert.equal(running, false);
  assert.equal(service.isBusy(), false);
  assert.equal(drained, 1);
});

test("shutdown cancels compact without starting queued work", async () => {
  let drained = 0;
  const session = {
    thread: { getId: () => "thread" },
    run: { isRunning: () => false, ensureAbortController: () => new AbortController(), reset() {} },
    approval: { isArmed: () => false }, suspensions: { hasPending: () => false },
    drainFollowUpQueue: async () => { drained++; },
  } as unknown as Session;
  const service = new MemoryService(session, {
    isCompacting: () => false, cancel() {}, drain: async () => {},
    compactManual: async ({ signal }) => { signal.throwIfAborted(); return { status: "skipped", reason: "small" }; },
  });
  const pending = service.compact();
  await service.shutdown();
  await assert.rejects(pending, /abort/i);
  assert.equal(drained, 0);
});
