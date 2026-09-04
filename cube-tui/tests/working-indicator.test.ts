import assert from "node:assert/strict";
import test from "node:test";
import { WorkingIndicator, deriveWorkingIndicatorState, renderShimmerText } from "../src/components/working-indicator.js";

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

test("indicator distinguishes approval, tools, memory, and reasoning", () => {
  assert.deepEqual(
    deriveWorkingIndicatorState(
      state({
        pendingApproval: {
          toolCallId: "call-1",
          toolName: "execute_command",
          args: {},
        },
      }) as never,
      true,
    ),
    { visible: true, spinning: false, phase: "approval", message: "Waiting for approval: execute_command" },
  );

  assert.deepEqual(
    deriveWorkingIndicatorState(
      state({
        activeTools: new Map([
          ["call-1", { name: "execute_command", args: {}, status: "running" }],
        ]),
      }) as never,
      false,
    ),
    { visible: true, spinning: true, phase: "tool", message: "Running execute_command" },
  );

  assert.deepEqual(
    deriveWorkingIndicatorState(
      state({ omProgress: { status: "observing" } }) as never,
      false,
    ),
    { visible: true, spinning: true, phase: "memory", message: "Observing memory" },
  );

  assert.deepEqual(
    deriveWorkingIndicatorState(
      state({
        currentMessage: {
          role: "assistant",
          content: { parts: [{ type: "reasoning", reasoning: "checking" }] },
        },
      }) as never,
      false,
    ),
    { visible: true, spinning: true, phase: "thinking", message: "Thinking" },
  );
});

test("indicator hides once assistant text is visibly streaming", () => {
  assert.deepEqual(
    deriveWorkingIndicatorState(
      state({
        currentMessage: {
          role: "assistant",
          content: { parts: [{ type: "text", text: "answer" }] },
        },
      }) as never,
      false,
    ),
    { visible: false, spinning: false, phase: "streaming", message: "Responding" },
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
      false,
    ),
    { visible: true, spinning: true, phase: "subagent", message: "Running Explore" },
  );

  assert.deepEqual(
    deriveWorkingIndicatorState(
      state({ bufferingMessages: true }) as never,
      false,
    ),
    { visible: true, spinning: true, phase: "memory", message: "Buffering messages" },
  );

  assert.deepEqual(
    deriveWorkingIndicatorState(
      state({ bufferingObservations: true }) as never,
      false,
    ),
    { visible: true, spinning: true, phase: "memory", message: "Buffering observations" },
  );
});

test("indicator distinguishes preparing, waiting input, responding, and unknown work", () => {
  assert.deepEqual(
    deriveWorkingIndicatorState(state({
      activeTools: new Map([["call-1", { name: "execute_command", status: "streaming_input" }]]),
    }) as never, false),
    { visible: true, spinning: true, phase: "tool", message: "Preparing execute_command" },
  );
  assert.deepEqual(
    deriveWorkingIndicatorState(state({
      pendingSuspensions: new Map([["one", { toolName: "ask_user" }]]),
    }) as never, false),
    { visible: true, spinning: true, phase: "input", message: "Waiting for input" },
  );
  assert.deepEqual(
    deriveWorkingIndicatorState(state() as never, false),
    { visible: true, spinning: true, phase: "thinking", message: "Working" },
  );
});

test("indicator ignores stale display approval after the native gate disarms", () => {
  const snapshot = state({
    pendingApproval: {
      toolCallId: "call-1",
      toolName: "execute_command",
      args: {},
    },
    activeTools: new Map([
      ["call-1", { name: "execute_command", args: {}, status: "running" }],
    ]),
  });

  assert.equal(
    deriveWorkingIndicatorState(snapshot as never, false).phase,
    "tool",
  );
  assert.equal(
    deriveWorkingIndicatorState(snapshot as never, true).phase,
    "approval",
  );
});

test("waiting indicator stays visible without spinner timer or interrupt hint", () => {
  const indicator = new WorkingIndicator(
    { requestRender() {} } as never,
    {
      now: () => 10_000,
      schedule: () => { throw new Error("waiting state must not schedule spinner"); },
      spinnerStyle: (text) => text,
      messageStyle: (text) => text,
      timerStyle: (text) => text,
    },
  );
  indicator.sync(
    state({ pendingApproval: { toolName: "execute_command" } }) as never,
    true,
  );
  const rendered = indicator.render(100).join("\n");
  assert.match(rendered, /Waiting for approval: execute_command/);
  assert.doesNotMatch(rendered, /interrupt|0s/);
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

test("input indicator spins with elapsed time and an Escape cancel hint", () => {
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

  indicator.sync(
    state({ pendingSuspensions: new Map([["one", { toolName: "ask_user" }]]) }) as never,
    false,
  );
  assert.match(indicator.render(100).join("\n"), /Waiting for input \(0s • Esc to cancel\)/);
  indicator.stop();
});

test("background memory indicator does not claim Escape can cancel it", () => {
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

  indicator.sync(state({ bufferingMessages: true }) as never, false);
  const rendered = indicator.render(100).join("\n");
  assert.match(rendered, /Buffering messages \(0s\)/);
  assert.doesNotMatch(rendered, /Esc/);
  indicator.stop();
});

test("indicator timer restarts when the native work phase changes", () => {
  let now = 10_000;
  const timer = { unref() {} } as NodeJS.Timeout;
  const indicator = new WorkingIndicator(
    { requestRender() {} } as never,
    {
      now: () => now,
      schedule: () => timer,
      cancelSchedule: () => undefined,
      spinnerStyle: (text) => text,
      messageStyle: (text) => text,
      timerStyle: (text) => text,
    },
  );

  indicator.sync(state() as never, false);
  now = 166_000;
  assert.match(indicator.render(100).join("\n"), /156s/);

  indicator.sync(state({ bufferingMessages: true }) as never, false);
  assert.match(indicator.render(100).join("\n"), /Buffering messages \(0s/);
  indicator.stop();
});

test("renderShimmerText applies wave highlights across character frames", () => {
  const text = "Thinking";
  const frame0 = renderShimmerText(text, 0);
  assert.equal(typeof frame0, "string");
  assert.equal(frame0.includes("Thinking") || frame0.length >= text.length, true);
  assert.equal(renderShimmerText("", 0), "");
});
