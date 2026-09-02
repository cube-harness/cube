import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "@cube/agent";
import { MemoryService } from "../../src/services/memory.service.js";

const session = (threadId: string | null, running = false): Session =>
  ({
    thread: { getId: () => threadId },
    identity: { getResourceId: () => "workspace-1" },
    run: { isRunning: () => running },
  }) as unknown as Session;

test("MemoryService rejects compact without an active thread or during an active turn", async () => {
  const calls: unknown[] = [];
  const finalize = async (input: unknown) => {
    calls.push(input);
    return {
      enabled: true,
      activated: true,
      observed: false,
      reflected: false,
    };
  };

  await assert.rejects(
    new MemoryService(session(null), finalize).compact(),
    /No active thread/,
  );
  await assert.rejects(
    new MemoryService(session("thread-1", true), finalize).compact(),
    /agent turn is active/,
  );
  assert.deepEqual(calls, []);
});

test("MemoryService rejects a disabled observational-memory pipeline", async () => {
  const service = new MemoryService(session("thread-1"), async () => ({
    enabled: false,
    activated: false,
    observed: false,
    reflected: false,
  }));

  await assert.rejects(service.compact(), /Observational Memory is disabled/);
});

test("MemoryService finalizes the active thread and returns public outcome flags", async () => {
  const calls: unknown[] = [];
  const service = new MemoryService(session("thread-1"), async (input) => {
    calls.push(input);
    return {
      enabled: true,
      activated: true,
      observed: false,
      reflected: false,
    };
  });

  assert.deepEqual(await service.compact(), {
    activated: true,
    observed: false,
    reflected: false,
  });
  assert.deepEqual(calls, [
    { threadId: "thread-1", resourceId: "workspace-1" },
  ]);
});
