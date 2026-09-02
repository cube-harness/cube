import assert from "node:assert/strict";
import test from "node:test";
import type {
  CubeRuntime,
  ModelSelection,
  PromptResult,
  RuntimeDisplayState,
  RuntimeEventListener,
  ToolApprovalResponse,
} from "@cube/runtime";
import { CubeApp } from "../src/app.js";
import type { ChatScreen } from "../src/screens/chat.screen.js";

const displayState = (text: string, queuedFollowUps = 0) => ({
  isRunning: true,
  currentMessage: {
    id: "assistant-1",
    role: "assistant",
    content: { parts: [{ type: "text", text }] },
  },
  activeTools: new Map(),
  pendingApproval: null,
  pendingSuspensions: new Map(),
  activeSubagents: new Map(),
  omProgress: { status: "idle" },
  bufferingMessages: false,
  bufferingObservations: false,
  queuedFollowUps,
}) as unknown as RuntimeDisplayState;

const createScreen = () => {
  const calls: unknown[][] = [];
  const queued: string[] = [];
  const screen = {
    promptEditor: {
      enqueueQueuedPrompt: (content: string) => queued.push(content),
      popQueuedPrompt: () => queued.pop(),
      dequeueQueuedPrompts: (count: number) => queued.splice(0, count),
      clearQueuedPrompts: () => queued.splice(0),
    },
    messageList: {
      toggleTranscript: () => true,
      addMessage: (message: unknown) => calls.push(["message", message]),
    },
    workingIndicator: { isActive: () => false },
    mount: (handlers: unknown) => calls.push(["mount", handlers]),
    startTerminal: () => calls.push(["startTerminal"]),
    stopTerminal: () => calls.push(["stopTerminal"]),
    addInputListener: () => () => undefined,
    renderDisplayState: (
      state: RuntimeDisplayState,
      approvalPending: boolean,
    ) => calls.push(["renderDisplayState", state, approvalPending]),
    addUserMessage: (content: string) => calls.push(["addUserMessage", content]),
    showThread: (snapshot: unknown) => calls.push(["showThread", snapshot]),
    showNotice: (notice: unknown) => calls.push(["showNotice", notice]),
    showUsage: (metrics: unknown) => calls.push(["showUsage", metrics]),
    clearConversation: () => calls.push(["clearConversation"]),
    setInfo: (info: unknown) => calls.push(["setInfo", info]),
    setStatusLine: (fields: string[]) => calls.push(["setStatusLine", fields]),
    pickModel: async () =>
      ({ modelId: "openrouter/test", reasoningEffort: "high" }) as ModelSelection,
    pickThread: async () => "thread-2",
    pickTheme: async () => "dracula",
    pickTitle: async () => ["model", "threadId"],
    pickStatusLine: async () => ["workspace", "agentMd"],
    requestApproval: async () => "approve" as const,
    requestToolSuspension: async (input: unknown) => {
      calls.push(["requestToolSuspension", input]);
      return { kind: "resume", resumeData: "write_file" };
    },
    cancelToolSuspension: (toolCallId: string) =>
      calls.push(["cancelToolSuspension", toolCallId]),
    requestRender: () => calls.push(["requestRender"]),
  } as unknown as ChatScreen;
  return { screen, calls, queued };
};

const createRuntime = (initial = displayState("initial")) => {
  const calls: unknown[][] = [];
  const approvals: ToolApprovalResponse[] = [];
  const suspensions: unknown[] = [];
  let approvalPending = false;
  let listener: RuntimeEventListener | undefined;
  const runtime = {
    prompt: {
      submit: async () => ({ kind: "submitted" as const }),
      cancelLatestQueued: () => null,
    },
    thread: {
      current: () => "thread-1",
      resume: async (threadId: string) => {
        calls.push(["thread.resume", threadId]);
        return { threadId, title: "Two", messages: [] };
      },
      delete: async (threadId: string) => {
        calls.push(["thread.delete", threadId]);
        return { threadId, wasActive: false };
      },
    },
    model: {
      current: () => ({ modelId: "google/gemini-3.7-flash" }),
      set: async (selection: ModelSelection) => {
        calls.push(["model.set", selection]);
        return selection;
      },
    },
    preference: {
      get: () => ({
        theme: "default",
        appTitle: ["model"],
        statusLine: ["model"],
      }),
      setTheme: async (theme: string) => ({
        theme,
        appTitle: ["model"],
        statusLine: ["model"],
      }),
      setTitle: async (appTitle: string[]) => ({
        theme: "default",
        appTitle,
        statusLine: ["model"],
      }),
      setStatusLine: async (statusLine: string[]) => ({
        theme: "default",
        appTitle: ["model"],
        statusLine,
      }),
    },
    memory: {},
    suggestions: [],
    workspaceRoot: "D:\\cube",
    getDisplayState: () => initial,
    isApprovalPending: () => approvalPending,
    subscribe: (value: RuntimeEventListener) => {
      listener = value;
      return () => calls.push(["unsubscribe"]);
    },
    interrupt: () => {
      calls.push(["interrupt"]);
      return true;
    },
    respondToApproval: (input: ToolApprovalResponse) => {
      approvals.push(input);
      approvalPending = false;
    },
    respondToSuspension: async (input: unknown) => {
      suspensions.push(input);
    },
    shutdown: async () => calls.push(["shutdown"]),
  } as unknown as CubeRuntime;
  return {
    runtime,
    calls,
    approvals,
    suspensions,
    getListener: () => listener,
    setApprovalPending: (value: boolean) => {
      approvalPending = value;
    },
  };
};

test("CubeApp forwards every native display snapshot without a second queue", () => {
  const { runtime } = createRuntime();
  const { screen, calls } = createScreen();
  const app = new CubeApp(runtime, screen, {
    onExitRequested: () => undefined,
  });

  app.handleRuntimeEvent({
    type: "display_state_changed",
    displayState: displayState("one"),
  } as never);
  app.handleRuntimeEvent({
    type: "display_state_changed",
    displayState: displayState("two"),
  } as never);
  const rendered = calls
    .filter((call) => call[0] === "renderDisplayState")
    .map((call) =>
      ((call[1] as RuntimeDisplayState).currentMessage?.content as {
        parts: Array<{ text: string }>;
      }).parts[0]?.text
    );
  assert.deepEqual(rendered, ["one", "two"]);
});

test("CubeApp maps domain results to client interactions without raw Session access", async () => {
  const { runtime, calls: runtimeCalls } = createRuntime();
  const { screen, calls } = createScreen();
  const copied: string[] = [];
  let exits = 0;
  const app = new CubeApp(runtime, screen, {
    copyToClipboard: async (content) => {
      copied.push(content);
      return true;
    },
    onExitRequested: () => {
      exits += 1;
    },
  });
  const snapshot = { threadId: "thread-2", title: "Two", messages: [] };
  const catalog = { updatedAt: "1970-01-01T00:00:00.000Z", providers: {} };

  await app.handlePromptResult({
    kind: "models",
    catalog,
    current: { modelId: "google/gemini-3.7-flash" },
  });
  await app.handlePromptResult({
    kind: "threads",
    operation: "resume",
    threads: [],
  });
  await app.handlePromptResult({
    kind: "threads",
    operation: "delete",
    threads: [],
  });
  await app.handlePromptResult({ kind: "thread", snapshot });
  await app.handlePromptResult({ kind: "thread-reset" });
  await app.handlePromptResult({
    kind: "preference",
    preference: {
      theme: "dracula",
      appTitle: ["model", "threadId"],
      statusLine: ["workspace"],
    },
  });
  await app.handlePromptResult({ kind: "copy-content", content: "markdown" });
  await app.handlePromptResult({ kind: "exit-requested" });

  assert.deepEqual(runtimeCalls, [
    [
      "model.set",
      { modelId: "openrouter/test", reasoningEffort: "high" },
    ],
    ["thread.resume", "thread-2"],
    ["thread.delete", "thread-2"],
  ]);
  assert.equal(
    calls.filter((call) => call[0] === "showThread").length,
    2,
  );
  assert.equal(
    calls.filter((call) => call[0] === "clearConversation").length,
    1,
  );
  assert.deepEqual(copied, ["markdown"]);
  assert.equal(exits, 1);
  assert.equal("session" in runtime, false);
});

test("CubeApp renders submitted user input before runtime submission settles", async () => {
  let resolveSubmit: ((result: PromptResult) => void) | undefined;
  const idle = { ...displayState("idle"), isRunning: false } as RuntimeDisplayState;
  const { runtime } = createRuntime(idle);
  runtime.prompt.submit = () =>
    new Promise<PromptResult>((resolve) => {
      resolveSubmit = resolve;
    });
  const { screen, calls } = createScreen();
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });

  const pending = app.submitPrompt("hello");
  assert.deepEqual(calls[0], ["addUserMessage", "hello"]);
  resolveSubmit?.({ kind: "submitted" });
  await pending;
});

test("CubeApp does not render slash commands as conversation user messages", async () => {
  const idle = { ...displayState("idle"), isRunning: false } as RuntimeDisplayState;
  const { runtime } = createRuntime(idle);
  runtime.prompt.submit = async () => ({
    kind: "models",
    catalog: { updatedAt: "1970-01-01T00:00:00.000Z", providers: {} },
    current: { modelId: "google/gemini-3.7-flash" },
  });
  const { screen, calls } = createScreen();
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });

  await app.submitPrompt("/model");

  assert.equal(
    calls.some((call) => call[0] === "addUserMessage"),
    false,
  );
});

test("CubeApp resolves native approval events through the runtime facade", async () => {
  const { runtime, approvals } = createRuntime();
  const { screen } = createScreen();
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });

  app.handleRuntimeEvent({
    type: "tool_approval_required",
    toolCallId: "call-1",
    toolName: "mastra_workspace_execute_command",
    args: { command: "Get-Date" },
  } as never);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(approvals, [
    {
      toolCallId: "call-1",
      toolName: "mastra_workspace_execute_command",
      decision: "approve",
    },
  ]);
});

test("CubeApp clears approval indicator immediately after the native gate resolves", async () => {
  const stale = {
    ...displayState("tool"),
    activeTools: new Map([
      ["call-1", { name: "execute_command", args: {}, status: "running" }],
    ]),
    pendingApproval: {
      toolCallId: "call-1",
      toolName: "execute_command",
      args: { command: "Get-Date" },
    },
  } as unknown as RuntimeDisplayState;
  const { runtime, setApprovalPending } = createRuntime(stale);
  setApprovalPending(true);
  const { screen, calls } = createScreen();
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });

  app.handleRuntimeEvent({
    type: "tool_approval_required",
    toolCallId: "call-1",
    toolName: "execute_command",
    args: { command: "Get-Date" },
  } as never);
  await new Promise((resolve) => setImmediate(resolve));

  const renders = calls.filter((call) => call[0] === "renderDisplayState");
  assert.equal(renders.at(-1)?.[1], stale);
  assert.equal(renders.at(-1)?.[2], false);
});

test("CubeApp routes ask_user through the generic native suspension UI", async () => {
  const { runtime, suspensions } = createRuntime();
  const { screen, calls } = createScreen();
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });

  app.handleRuntimeEvent({
    type: "tool_suspended",
    toolCallId: "call-ask",
    toolName: "ask_user",
    args: {},
    suspendPayload: {
      question: "Bạn muốn demo tool nào tiếp theo?",
      options: [
        { label: "write_file", description: "Tạo một file mới" },
        { label: "edit_file", description: "Sửa một file" },
      ],
      selectionMode: "single_select",
    },
  } as never);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.some((call) => call[0] === "requestApproval"), false);
  assert.deepEqual(
    calls.find((call) => call[0] === "requestToolSuspension"),
    [
      "requestToolSuspension",
      {
        toolCallId: "call-ask",
        toolName: "ask_user",
        args: {},
        suspendPayload: {
          question: "Bạn muốn demo tool nào tiếp theo?",
          options: [
            { label: "write_file", description: "Tạo một file mới" },
            { label: "edit_file", description: "Sửa một file" },
          ],
          selectionMode: "single_select",
        },
      },
    ],
  );
  assert.deepEqual(suspensions, [
    { toolCallId: "call-ask", resumeData: "write_file" },
  ]);
});

test("CubeApp presents parallel native suspensions one at a time in FIFO order", async () => {
  const { runtime, suspensions } = createRuntime();
  const { screen } = createScreen();
  const requested: unknown[] = [];
  const resolvers: Array<(answer: { kind: "resume"; resumeData: string }) => void> = [];
  screen.requestToolSuspension = (input: unknown) => {
    requested.push(input);
    return new Promise((resolve) => resolvers.push(resolve));
  };
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });
  const event = (toolCallId: string, question: string) => ({
    type: "tool_suspended",
    toolCallId,
    toolName: "ask_user",
    args: {},
    suspendPayload: { question },
  }) as never;

  app.handleRuntimeEvent(event("call-1", "First?"));
  app.handleRuntimeEvent(event("call-2", "Second?"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requested, [{
    toolCallId: "call-1",
    toolName: "ask_user",
    args: {},
    suspendPayload: { question: "First?" },
  }]);

  resolvers[0]?.({ kind: "resume", resumeData: "one" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requested, [
    {
      toolCallId: "call-1",
      toolName: "ask_user",
      args: {},
      suspendPayload: { question: "First?" },
    },
    {
      toolCallId: "call-2",
      toolName: "ask_user",
      args: {},
      suspendPayload: { question: "Second?" },
    },
  ]);

  resolvers[1]?.({ kind: "resume", resumeData: "two" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(suspensions, [
    { toolCallId: "call-1", resumeData: "one" },
    { toolCallId: "call-2", resumeData: "two" },
  ]);
});

test("CubeApp opens a picker and resumes submit_plan instead of silently ignoring it", async () => {
  const { runtime, suspensions } = createRuntime();
  const { screen, calls } = createScreen();
  screen.requestToolSuspension = async (input: unknown) => {
    calls.push(["requestToolSuspension", input]);
    return {
      kind: "resume",
      resumeData: {
        action: "approved",
        path: ".mastracode/plans/demo-tools-plan.md",
      },
    };
  };
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });

  app.handleRuntimeEvent({
    type: "tool_suspended",
    toolCallId: "call-plan",
    toolName: "submit_plan",
    args: { path: ".mastracode/plans/demo-tools-plan.md" },
    suspendPayload: { path: ".mastracode/plans/demo-tools-plan.md" },
    resumeSchema: '{"type":"object"}',
  } as never);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    calls.filter((call) => call[0] === "requestToolSuspension").length,
    1,
  );
  assert.deepEqual(suspensions, [{
    toolCallId: "call-plan",
    resumeData: {
      action: "approved",
      path: ".mastracode/plans/demo-tools-plan.md",
    },
  }]);
});

test("CubeApp dismisses a suspension picker when Session cancels that tool call", async () => {
  const { runtime } = createRuntime();
  const { screen, calls } = createScreen();
  screen.requestToolSuspension = () => new Promise(() => undefined);
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });

  app.handleRuntimeEvent({
    type: "tool_suspended",
    toolCallId: "call-cancelled",
    toolName: "custom_tool",
    args: {},
    suspendPayload: { reason: "Need input" },
  } as never);
  app.handleRuntimeEvent({
    type: "tool_suspension_cancelled",
    toolCallId: "call-cancelled",
    toolName: "custom_tool",
    reason: "Run aborted",
  } as never);

  assert.deepEqual(
    calls.filter((call) => call[0] === "cancelToolSuspension"),
    [["cancelToolSuspension", "call-cancelled"]],
  );
});

test("CubeApp renders an upstream runtime error as one readable system notice", () => {
  const { runtime } = createRuntime();
  const { screen, calls } = createScreen();
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });

  app.handleRuntimeEvent({
    type: "error",
    error: new Error("Provider is temporarily rate-limited"),
  } as never);

  assert.deepEqual(
    calls.filter((call) => call[0] === "showNotice"),
    [[
      "showNotice",
      {
        level: "error",
        message: "Error: Provider is temporarily rate-limited",
      },
    ]],
  );
});

test("CubeApp cancels queued prompts newest first before interrupting the active turn", async () => {
  const running = displayState("running");
  const { runtime, calls } = createRuntime(running);
  const nativeQueue: string[] = [];
  runtime.prompt.submit = async (content) => {
    nativeQueue.push(content);
    return { kind: "submitted" };
  };
  runtime.prompt.cancelLatestQueued = () => nativeQueue.pop() ?? null;
  const { screen, queued } = createScreen();
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });

  await app.submitPrompt("first");
  await app.submitPrompt("second");
  assert.deepEqual(queued, ["first", "second"]);
  assert.equal(app.handleInterrupt(), true);
  assert.deepEqual(queued, ["first"]);
  assert.equal(app.handleInterrupt(), true);
  assert.deepEqual(queued, []);
  assert.equal(calls.some((call) => call[0] === "interrupt"), false);
  assert.equal(app.handleInterrupt(), true);
  assert.equal(calls.some((call) => call[0] === "interrupt"), true);
});

test("CubeApp treats exit as interrupt while busy and exits only when idle", async () => {
  const state = displayState("running");
  const { runtime } = createRuntime(state);
  let interrupts = 0;
  runtime.interrupt = () => {
    if (!state.isRunning) return false;
    interrupts += 1;
    return true;
  };
  const { screen } = createScreen();
  let exits = 0;
  const app = new CubeApp(runtime, screen, {
    onExitRequested: () => {
      exits += 1;
    },
  });

  await app.handleExit();
  assert.equal(interrupts, 1);
  assert.equal(exits, 0);
  (state as { isRunning: boolean }).isRunning = false;
  await app.handleExit();
  assert.equal(exits, 1);
});
