import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalPicker,
  extractCommandPrefix,
} from "../src/components/approval-picker.js";
import { WorkingIndicator } from "../src/components/working-indicator.js";
import { PromptEditor } from "../src/components/prompt-editor.js";
import { CubeApp } from "../src/index.js";

const loadApprovalPicker = async () => {
  const module = await import("../src/components/approval-picker.js").catch(
    () => ({}),
  );
  assert.equal(
    typeof (module as { ApprovalPicker?: unknown }).ApprovalPicker,
    "function",
    "ApprovalPicker must exist",
  );
  return (module as { ApprovalPicker: new (options: any) => any })
    .ApprovalPicker;
};

test("ApprovalPicker approves the selected tool with Enter", async () => {
  const ApprovalPicker = await loadApprovalPicker();
  let decision: string | undefined;
  const picker = new ApprovalPicker({
    toolName: "mastra_workspace_execute_command",
    args: { command: "git status" },
    onDecision: (value: string) => {
      decision = value;
    },
  });

  picker.handleInput("\r");

  assert.equal(decision, "approve");
});

test("ApprovalPicker treats Escape as decline", async () => {
  const ApprovalPicker = await loadApprovalPicker();
  let decision: string | undefined;
  const picker = new ApprovalPicker({
    toolName: "mastra_workspace_execute_command",
    args: { command: "git status" },
    onDecision: (value: string) => {
      decision = value;
    },
  });

  picker.handleInput("\x1b");

  assert.equal(decision, "decline");
});

test("ApprovalPicker handles shortcut keys (y, p, n/esc/ctrl+c, 1, 2, 3)", async () => {
  const ApprovalPicker = await loadApprovalPicker();
  const testShortcut = (input: string) => {
    let decision: string | undefined;
    const picker = new ApprovalPicker({
      toolName: "mastra_workspace_execute_command",
      args: {
        command:
          "pnpm --filter @cube/agent exec tsx --test --test-isolation=none tests/controller.test.ts",
        reason: "Bạn có cho phép chạy lại test Controller sau khi bỏ storage riêng không?",
        environment: "local",
      },
      onDecision: (value: string) => {
        decision = value;
      },
    });
    picker.handleInput(input);
    return decision;
  };

  assert.equal(testShortcut("y"), "approve");
  assert.equal(testShortcut("Y"), "approve");
  assert.equal(testShortcut("1"), "approve");

  assert.equal(testShortcut("p"), "approve_prefix");
  assert.equal(testShortcut("P"), "approve_prefix");
  assert.equal(testShortcut("2"), "approve_prefix");

  assert.equal(testShortcut("n"), "decline");
  assert.equal(testShortcut("N"), "decline");
  assert.equal(testShortcut("3"), "decline");
  assert.equal(testShortcut("\x1b"), "decline");
  assert.equal(testShortcut("\x03"), "decline");
});

test("extractCommandPrefix extracts exact prefix from command", () => {
  assert.equal(
    extractCommandPrefix(
      "pnpm --filter @cube/agent exec tsx --test --test-isolation=none tests/controller.test.ts",
    ),
    "pnpm --filter @cube/agent exec tsx",
  );
  assert.equal(extractCommandPrefix("git status"), "git status");
  assert.equal(extractCommandPrefix("npm run build --flag"), "npm run build");
});

test("CubeApp consumes native Session approval without dispatching a Cube UI action", async () => {
  const tui = {
    children: [] as any[],
    focused: null as any,
    addChild(component: any) {
      this.children.push(component);
    },
    removeChild(component: any) {
      this.children = this.children.filter((child) => child !== component);
    },
    setFocus(component: any) {
      this.focused = component;
    },
    requestRender() {},
    addInputListener() {
      return () => {};
    },
    start() {},
    stop() {},
  };
  const listeners = new Set<(event: any) => void>();
  const approvals: any[] = [];
  const session = {
    subscribe(listener: (event: any) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    displayState: {
      get: () => ({
        isRunning: true,
        currentMessage: null,
        activeTools: new Map(),
        pendingApproval: {
          toolCallId: "tool-1",
          toolName: "mastra_workspace_execute_command",
          args: { command: "Get-Date" },
        },
        pendingSuspensions: new Map(),
        activeSubagents: new Map(),
        omProgress: { status: "idle" },
        bufferingMessages: false,
        bufferingObservations: false,
      }),
    },
    thread: {
      getId: () => "thread-1",
      listMessages: async () => [],
    },
    respondToToolApproval(input: any) {
      approvals.push(input);
    },
    abort() {},
  };
  const actions: any[] = [];
  const app = CubeApp({
    tui: tui as any,
    session: session as any,
    onAction: (action) => actions.push(action),
  });

  for (const listener of listeners) {
    listener({
      type: "display_state_changed",
      displayState: session.displayState.get(),
    });
  }
  const indicator = tui.children.find(
    (child) => child instanceof WorkingIndicator,
  ) as WorkingIndicator | undefined;
  if (!indicator) {
    app.stop();
    assert.fail("CubeApp must mount into the injected TUI");
  }
  assert.equal(indicator.isActive(), false);

  for (const listener of listeners) listener({
    type: "tool_approval_required",
    toolCallId: "tool-1",
    toolName: "mastra_workspace_execute_command",
    args: {
      command: "Get-Date",
      reason: "Get current system date",
      environment: "local",
    },
  });

  const picker = tui.children.find(
    (child) => child instanceof ApprovalPicker,
  ) as ApprovalPicker | undefined;
  assert.ok(picker);
  assert.equal(tui.focused, picker);
  assert.equal(indicator.isActive(), false);
  const rendered = picker.render(80).join("\n");
  assert.match(rendered, /Would you like to run the following command\?/);
  assert.match(rendered, /Environment:\s+local/);
  assert.match(rendered, /Reason:\s+Get current system date/);
  assert.match(rendered, /\$\s+Get-Date/);

  picker.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(approvals, [
    {
      toolCallId: "tool-1",
      decision: "approve",
    },
  ]);
  assert.deepEqual(actions, []);
  app.stop();
});

test("CubeApp routes Escape to native Session only while an agent turn is active", () => {
  const inputListeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
  const tui = {
    children: [] as any[],
    addChild(component: any) { this.children.push(component); },
    removeChild(component: any) { this.children = this.children.filter((child) => child !== component); },
    setFocus() {},
    requestRender() {},
    addInputListener(listener: (data: string) => { consume?: boolean } | undefined) {
      inputListeners.push(listener);
      return () => {};
    },
    start() {},
    stop() {},
  };
  const displayState = {
    isRunning: true,
    currentMessage: null,
    activeTools: new Map(),
    pendingApproval: null,
    pendingSuspensions: new Map(),
    activeSubagents: new Map(),
    omProgress: { status: "idle" },
    bufferingMessages: false,
    bufferingObservations: false,
  };
  let abortCount = 0;
  const session = {
    subscribe: () => () => {},
    displayState: { get: () => displayState },
    thread: { getId: () => null, listMessages: async () => [] },
    respondToToolApproval() {},
    grantTool() {},
    abort() { abortCount += 1; },
  };
  const actions: any[] = [];
  const app = CubeApp({
    tui: tui as any,
    session: session as any,
    onAction: (action) => actions.push(action),
  });

  const result = inputListeners[0]?.("\x1b");

  assert.deepEqual(result, { consume: true });
  assert.equal(abortCount, 1);
  assert.deepEqual(actions, []);
  displayState.isRunning = false;
  assert.equal(inputListeners[0]?.("\x1b"), undefined);
  assert.equal(abortCount, 1);
  app.stop();
});

test("CubeApp treats Ctrl+C as interrupt while busy and exits only after becoming idle", () => {
  const inputListeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
  const tui = {
    children: [] as any[],
    addChild(component: any) { this.children.push(component); },
    removeChild(component: any) { this.children = this.children.filter((child) => child !== component); },
    setFocus() {},
    requestRender() {},
    addInputListener(listener: (data: string) => { consume?: boolean } | undefined) {
      inputListeners.push(listener);
      return () => {};
    },
    start() {},
    stop() {},
  };
  const displayState = {
    isRunning: true,
    currentMessage: null,
    activeTools: new Map(),
    pendingApproval: null,
    pendingSuspensions: new Map(),
    activeSubagents: new Map(),
    omProgress: { status: "idle" },
    bufferingMessages: false,
    bufferingObservations: false,
    queuedFollowUps: 0,
  };
  let abortCount = 0;
  const session = {
    subscribe: () => () => {},
    displayState: { get: () => displayState },
    thread: { getId: () => null, listMessages: async () => [] },
    respondToToolApproval() {},
    grantTool() {},
    abort() { abortCount += 1; },
  };
  const actions: any[] = [];
  const app = CubeApp({
    tui: tui as any,
    session: session as any,
    onAction: (action) => actions.push(action),
  });

  assert.deepEqual(inputListeners[0]?.("\x03"), { consume: true });
  assert.deepEqual(actions, []);
  assert.equal(abortCount, 1);

  displayState.isRunning = false;
  app.handleSessionEvent({
    type: "display_state_changed",
    displayState,
  } as any);
  assert.deepEqual(inputListeners[0]?.("\x03"), { consume: true });
  assert.deepEqual(actions, [{ type: "app:exit" }]);
  assert.equal(abortCount, 1);
  app.stop();
});

test("CubeApp renders queued prompts and Escape removes them FIFO before aborting", () => {
  const inputListeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
  const sessionListeners: Array<(event: any) => void> = [];
  const tui = {
    terminal: { rows: 40, columns: 120 },
    children: [] as any[],
    addChild(component: any) { this.children.push(component); },
    removeChild(component: any) { this.children = this.children.filter((child) => child !== component); },
    setFocus() {},
    requestRender() {},
    addInputListener(listener: (data: string) => { consume?: boolean } | undefined) {
      inputListeners.push(listener);
      return () => {};
    },
    start() {},
    stop() {},
  };
  const displayState = {
    isRunning: true,
    currentMessage: null,
    activeTools: new Map(),
    pendingApproval: null,
    pendingSuspensions: new Map(),
    activeSubagents: new Map(),
    omProgress: { status: "idle" },
    bufferingMessages: false,
    bufferingObservations: false,
    queuedFollowUps: 0,
  };
  const nativeQueue: string[] = [];
  const emittedCounts: number[] = [];
  let abortCount = 0;
  const session = {
    subscribe(listener: (event: any) => void) {
      sessionListeners.push(listener);
      return () => {};
    },
    emit(event: any) {
      if (event.type === "follow_up_queued") {
        displayState.queuedFollowUps = event.count;
        emittedCounts.push(event.count);
      }
      for (const listener of sessionListeners) listener(event);
    },
    displayState: { get: () => displayState },
    followUps: {
      dequeue: () => nativeQueue.shift(),
      count: () => nativeQueue.length,
    },
    thread: { getId: () => null, listMessages: async () => [] },
    respondToToolApproval() {},
    grantTool() {},
    abort() { abortCount += 1; },
  };
  const actions: any[] = [];
  const app = CubeApp({
    tui: tui as any,
    session: session as any,
    onAction: (action) => {
      actions.push(action);
      if (action.type === "prompt:submit") nativeQueue.push(action.content);
    },
  });
  const editor = tui.children.find((child) => child instanceof PromptEditor) as PromptEditor;

  editor.setText("first queued prompt");
  editor.handleInput("\r");
  editor.setText("second queued prompt");
  editor.handleInput("\r");

  const queued = editor.render(100).join("\n");
  assert.match(queued, /Messages to be submitted after the current turn/);
  assert.match(queued, /first queued prompt/);
  assert.match(queued, /second queued prompt/);
  assert.deepEqual(actions, [
    { type: "prompt:submit", content: "first queued prompt" },
    { type: "prompt:submit", content: "second queued prompt" },
  ]);

  assert.deepEqual(inputListeners[0]?.("\x1b"), { consume: true });
  assert.doesNotMatch(editor.render(100).join("\n"), /first queued prompt/);
  assert.match(editor.render(100).join("\n"), /second queued prompt/);
  assert.equal(abortCount, 0);

  assert.deepEqual(inputListeners[0]?.("\x03"), { consume: true });
  assert.doesNotMatch(editor.render(100).join("\n"), /second queued prompt/);
  assert.equal(abortCount, 0);

  assert.deepEqual(inputListeners[0]?.("\x03"), { consume: true });
  assert.equal(abortCount, 1);
  assert.deepEqual(emittedCounts, [1, 0]);

  displayState.isRunning = false;
  app.stop();
});
