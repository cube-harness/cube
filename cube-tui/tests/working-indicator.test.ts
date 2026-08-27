import assert from "node:assert/strict";
import test from "node:test";
import { WorkingIndicator, deriveWorkingIndicatorState } from "../src/components/working-indicator.js";

const state = (overrides: Record<string, unknown> = {}) => ({
  isRunning: true,
  currentMessage: null,
  activeTools: new Map(),
  pendingApproval: null,
  pendingSuspensions: new Map(),
  activeSubagents: new Map(),
  omProgress: { status: "idle" },
  bufferingMessages: false,
  bufferingObservations: false,
  ...overrides,
});

test("indicator distinguishes approval, tools, memory, reasoning, and text streaming", () => {
  assert.deepEqual(
    deriveWorkingIndicatorState(
      state({
        pendingApproval: {
          toolCallId: "call-1",
          toolName: "execute_command",
          args: {},
        },
      }) as never,
    ),
    { active: false, phase: "approval", message: "Waiting for approval" },
  );

  assert.deepEqual(
    deriveWorkingIndicatorState(
      state({
        activeTools: new Map([
          ["call-1", { name: "execute_command", args: {}, status: "running" }],
        ]),
      }) as never,
    ),
    { active: true, phase: "tool", message: "Running execute_command" },
  );

  assert.deepEqual(
    deriveWorkingIndicatorState(
      state({ omProgress: { status: "observing" } }) as never,
    ),
    { active: true, phase: "memory", message: "Observing memory" },
  );

  assert.deepEqual(
    deriveWorkingIndicatorState(
      state({
        currentMessage: {
          role: "assistant",
          content: { parts: [{ type: "reasoning", reasoning: "checking" }] },
        },
      }) as never,
    ),
    { active: true, phase: "thinking", message: "Thinking" },
  );

  assert.deepEqual(
    deriveWorkingIndicatorState(
      state({
        currentMessage: {
          role: "assistant",
          content: { parts: [{ type: "text", text: "answer" }] },
        },
      }) as never,
    ),
    { active: false, phase: "streaming", message: "Responding" },
  );
});

test("indicator labels non-model subagent and buffering work explicitly", () => {
  assert.deepEqual(
    deriveWorkingIndicatorState(
      state({
        activeSubagents: new Map([
          ["sub-1", { agentType: "explore", displayName: "Explore", status: "running" }],
        ]),
      }) as never,
    ),
    { active: true, phase: "subagent", message: "Running Explore" },
  );

  assert.deepEqual(
    deriveWorkingIndicatorState(
      state({ bufferingMessages: true }) as never,
    ),
    { active: true, phase: "memory", message: "Buffering memory" },
  );
});

test("active indicator shows the centralized Escape interrupt hint", () => {
  const timer = { unref() {} } as NodeJS.Timeout;
  const indicator = new WorkingIndicator(
    { requestRender() {} } as never,
    {
      now: () => 10_000,
      schedule: () => timer,
      cancelSchedule: () => undefined,
      spinnerStyle: (text) => text,
      messageStyle: (text) => text,
      timerStyle: (text) => text,
    },
  );

  indicator.start("Working");
  assert.match(indicator.render(100).join("\n"), /0s • Esc to interrupt/);
  indicator.stop();
});
