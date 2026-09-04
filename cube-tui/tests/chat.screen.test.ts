import assert from "node:assert/strict";
import test from "node:test";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { RuntimeDisplayState } from "@cube/runtime";
import { ChatScreen } from "../src/screens/chat.screen.js";

const createTui = () => {
  const added: Component[] = [];
  const removed: Component[] = [];
  let focused: Component | null = null;
  let renders = 0;
  const tui = {
    addChild: (component: Component) => added.push(component),
    removeChild: (component: Component) => removed.push(component),
    setFocus: (component: Component) => {
      focused = component;
    },
    requestRender: () => {
      renders += 1;
    },
  } as unknown as TUI;
  return {
    tui,
    added,
    removed,
    getFocused: () => focused,
    getRenders: () => renders,
  };
};

test("ChatScreen mounts its concrete components in one stable order", () => {
  const fake = createTui();
  const screen = new ChatScreen({ tui: fake.tui, basePath: "D:\\cube" });
  screen.mount({ onSubmit: async () => undefined });

  assert.deepEqual(fake.added, [
    screen.banner,
    screen.infoBox,
    screen.messageList,
    screen.workingIndicator,
    screen.promptEditor,
    screen.footer,
  ]);
  assert.equal(fake.getFocused(), screen.promptEditor);
  screen.unmount();
});

test("ChatScreen owns one-shot picker replacement and restoration", async () => {
  const fake = createTui();
  const screen = new ChatScreen({ tui: fake.tui, basePath: "D:\\cube" });
  screen.mount({ onSubmit: async () => undefined });
  fake.added.length = 0;
  fake.removed.length = 0;

  const selection = screen.pickThread([
    {
      id: "thread-2",
      title: "Two",
      updatedAt: "2026-08-28T00:00:00.000Z",
      isActive: false,
    },
  ]);
  const picker = fake.added[0] as Component & { handleInput(data: string): void };
  assert.deepEqual(fake.removed, [screen.footer, screen.promptEditor]);
  assert.deepEqual(fake.added, [picker, screen.footer]);
  assert.equal(fake.getFocused(), picker);

  picker.handleInput("\r");
  picker.handleInput("\r");
  assert.equal(await selection, "thread-2");
  assert.deepEqual(fake.removed, [
    screen.footer,
    screen.promptEditor,
    screen.footer,
    picker,
  ]);
  assert.deepEqual(fake.added, [
    picker,
    screen.footer,
    screen.promptEditor,
    screen.footer,
  ]);
  assert.equal(fake.getFocused(), screen.promptEditor);
  screen.unmount();
});

test("ChatScreen can dismiss the active native suspension picker by tool call id", async () => {
  const fake = createTui();
  const screen = new ChatScreen({ tui: fake.tui, basePath: "D:\\cube" });
  screen.mount({ onSubmit: async () => undefined });

  const pending = screen.requestToolSuspension({
    toolCallId: "call-1",
    toolName: "custom_tool",
    args: {},
    suspendPayload: { reason: "Need input" },
  });
  assert.notEqual(fake.getFocused(), screen.promptEditor);

  screen.cancelToolSuspension("call-1");

  assert.deepEqual(await pending, { kind: "dismissed" });
  assert.equal(fake.getFocused(), screen.promptEditor);
  screen.unmount();
});

test("ChatScreen routes only the native message to the list and lifecycle to the indicator", () => {
  const fake = createTui();
  const screen = new ChatScreen({ tui: fake.tui, basePath: "D:\\cube" });
  const calls: unknown[][] = [];
  screen.messageList.applySessionMessage = (message, streaming) => {
    calls.push(["message", message, streaming]);
  };
  screen.workingIndicator.sync = (displayState, approvalPending) => {
    calls.push(["indicator", displayState, approvalPending]);
    return { visible: false, spinning: false, phase: "idle", message: "" };
  };
  const currentMessage = {
    id: "assistant-1",
    role: "assistant",
    content: { parts: [{ type: "text", text: "hello" }] },
  };
  const state = {
    isRunning: false,
    currentMessage,
    activeTools: new Map(),
    pendingApproval: null,
    pendingSuspensions: new Map(),
    queuedFollowUps: 0,
  } as unknown as RuntimeDisplayState;

  const rendersBefore = fake.getRenders();
  screen.renderDisplayState(state, false);
  assert.deepEqual(calls, [
    ["message", currentMessage, false],
    ["indicator", state, false],
  ]);
  assert.equal(fake.getRenders() - rendersBefore, 1);
  screen.unmount();
});

test("ChatScreen pauses prompt cursor blinking while the working indicator spins", () => {
  const fake = createTui();
  const screen = new ChatScreen({ tui: fake.tui, basePath: "D:\\cube" });
  const blinking: boolean[] = [];
  const promptEditor = screen.promptEditor as typeof screen.promptEditor & {
    setCursorBlinking(enabled: boolean): void;
  };
  promptEditor.setCursorBlinking = (enabled) => blinking.push(enabled);

  const displayState = {
    isRunning: true,
    currentMessage: null,
    activeTools: new Map(),
    pendingApproval: null,
    pendingSuspensions: new Map(),
    activeSubagents: new Map(),
    queuedFollowUps: 0,
    omProgress: { status: "idle" },
    bufferingMessages: false,
    bufferingObservations: false,
  } as unknown as RuntimeDisplayState;

  screen.workingIndicator.sync = () => ({
    visible: true,
    spinning: true,
    phase: "thinking",
    message: "Working",
  });
  screen.renderDisplayState(displayState, false);

  screen.workingIndicator.sync = () => ({
    visible: false,
    spinning: false,
    phase: "streaming",
    message: "Responding",
  });
  screen.renderDisplayState(displayState, false);

  assert.deepEqual(blinking, [false, true]);
  screen.unmount();
});

test("ChatScreen passes the elapsed native reasoning phase duration to the message list", () => {
  const fake = createTui();
  const screen = new ChatScreen({ tui: fake.tui, basePath: "D:\\cube" });
  const calls: unknown[][] = [];
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  screen.messageList.applySessionMessage = (...args) => {
    calls.push(args);
  };

  const baseState = {
    currentMessage: null,
    activeTools: new Map(),
    pendingApproval: null,
    pendingSuspensions: new Map(),
    activeSubagents: new Map(),
    queuedFollowUps: 0,
    omProgress: { status: "idle" },
    bufferingMessages: false,
    bufferingObservations: false,
  };
  const reasoningMessage = {
    id: "assistant-reasoning",
    role: "assistant",
    content: { parts: [{ type: "reasoning", reasoning: "private" }] },
  };
  screen.renderDisplayState({
    ...baseState,
    isRunning: true,
    currentMessage: reasoningMessage,
    tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
  } as RuntimeDisplayState, false);

  now = 14_500;
  const completedReasoningMessage = {
    ...reasoningMessage,
    content: {
      parts: [
        reasoningMessage.content.parts[0],
        { type: "tool-invocation", toolInvocation: { toolCallId: "call-1", toolName: "read_file", state: "call", args: { path: "package.json" } } },
      ],
    },
  };
  screen.renderDisplayState({
    ...baseState,
    isRunning: true,
    currentMessage: completedReasoningMessage,
    tokenUsage: { promptTokens: 100, completionTokens: 62, totalTokens: 162 },
  } as RuntimeDisplayState, false);

  try {
    assert.deepEqual(calls.at(-1), [completedReasoningMessage, true, 4_500]);
  } finally {
    Date.now = originalNow;
    screen.unmount();
  }
});
