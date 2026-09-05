import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "@cube/agent";
import { CubeRuntime } from "../src/runtime.js";

test("CubeRuntime exposes ready services while keeping the native Session private", async () => {
  const displayState = { isRunning: true, messages: [] };
  const events: unknown[] = [];
  const approvals: unknown[] = [];
  const suspensions: unknown[] = [];
  let listenerCalls = 0;
  let unsubscribeCalls = 0;
  let aborted = 0;
  let approvalArmed = true;
  let released = 0;
  let shutdownCalls = 0;
  const unsubscribe = () => {
    unsubscribeCalls += 1;
  };
  const session = {
    displayState: { get: () => displayState },
    subscribe: (listener: (event: unknown) => void) => {
      listenerCalls += 1;
      listener({ type: "display_state", displayState });
      return unsubscribe;
    },
    run: { isRunning: () => true },
    abort: () => {
      aborted += 1;
    },
    grantTool: (toolName: string) => approvals.push(["grant", toolName]),
    approval: { isArmed: () => approvalArmed },
    respondToToolApproval: (input: unknown) => approvals.push(["respond", input]),
    respondToToolSuspension: async (input: unknown) => suspensions.push(input),
    suspensions: { hasPending: () => false },
    thread: {
      getId: () => "thread-1",
      clearAndReleaseLock: async () => {
        released += 1;
      },
    },
  } as unknown as Session;
  const prompt = { marker: "prompt" };
  const thread = { marker: "thread" };
  const model = { marker: "model" };
  const preference = { marker: "preference" };
  const memory = { marker: "memory" };
  const gateway = { marker: "gateway" };
  const runtime = new CubeRuntime({
    session,
    prompt,
    thread,
    model,
    preference,
    memory,
    gateway,
    suggestions: [{ name: "/help", description: "Help" }],
    workspaceRoot: "D:\\cube",
    readHistory: async () => ["one", "two"],
    shutdownResources: async () => {
      shutdownCalls += 1;
    },
  } as never);

  assert.equal(runtime.prompt, prompt);
  assert.equal(runtime.thread, thread);
  assert.equal(runtime.model, model);
  assert.equal(runtime.preference, preference);
  assert.equal(runtime.memory, memory);
  assert.equal(runtime.gateway, gateway);
  assert.equal("session" in runtime, false);
  assert.deepEqual(runtime.getDisplayState(), displayState);
  assert.equal(runtime.isApprovalPending(), true);
  approvalArmed = false;
  assert.equal(runtime.isApprovalPending(), false);
  assert.deepEqual(await runtime.getHistory(), ["one", "two"]);
  assert.equal(runtime.workspaceRoot, "D:\\cube");
  assert.deepEqual(runtime.suggestions, [{ name: "/help", description: "Help" }]);

  const received: unknown[] = [];
  const dispose = runtime.subscribe((event) => received.push(event));
  assert.equal(listenerCalls, 1);
  assert.deepEqual(received, events.concat([{ type: "display_state", displayState }]));
  assert.equal(dispose, unsubscribe);
  dispose();
  assert.equal(unsubscribeCalls, 1);

  assert.equal(runtime.interrupt(), true);
  assert.equal(aborted, 1);
  runtime.respondToApproval({
    toolCallId: "call-1",
    toolName: "execute_command",
    decision: "approve_prefix",
  });
  assert.deepEqual(approvals, [
    ["grant", "execute_command"],
    ["respond", { decision: "approve", toolCallId: "call-1" }],
  ]);
  await runtime.respondToSuspension({
    toolCallId: "call-2",
    resumeData: "write_file",
  });
  assert.deepEqual(suspensions, [
    { toolCallId: "call-2", resumeData: "write_file" },
  ]);

  const firstShutdown = runtime.shutdown();
  const secondShutdown = runtime.shutdown();
  assert.equal(firstShutdown, secondShutdown);
  await firstShutdown;
  assert.equal(released, 1);
  assert.equal(shutdownCalls, 1);
});
