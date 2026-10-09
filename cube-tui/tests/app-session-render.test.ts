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
import { CubeApp, startPreparedCube } from "../src/app.js";
import { PromptService } from "../../cube-runtime/src/services/prompt.service.js";
import type { ChatScreen } from "../src/screens/chat.screen.js";
import type { SubagentApprovalRequest } from "../src/components/subagent-approval-picker.js";

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
    workingIndicator: {
      isActive: () => false,
      stop: () => calls.push(["workingIndicator.stop"]),
    },
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
    setActivityCounts: (background: number, subagents: number) => calls.push(["setActivityCounts", background, subagents]),
    setSkillProvider: () => undefined,
    setSubmitHandler: (handler: unknown) => calls.push(["setSubmitHandler", handler]),
    pickModel: async () =>
      ({ modelId: "openrouter/test", reasoningEffort: "high" }) as ModelSelection,
    pickGateway: async () => ({ draftId: "draft-1", model: { modelId: "google/new" } }),
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
    gateway: {
      set: async (selection: unknown) => {
        calls.push(["gateway.set", selection]);
        return { gatewayId: "api_key/google", model: { modelId: "google/new" } };
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
    getInstructionInfo: () => ({ soulCharacters: 6837, agentsFiles: 2, agentsCharacters: 4120 }),
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
  assert.ok(calls.some(([name, value]) => name === "setInfo" &&
    (value as any).soul === "Loaded · 6,837 chars" &&
    (value as any).agentMd === "Loaded · 2 files · 4,120 chars"));
  runtime.getInstructionInfo = () => ({ soulCharacters: 10, agentsFiles: 0, agentsCharacters: 0 });
  app.handleRuntimeEvent({ type: "display_state_changed", displayState: displayState("next") } as never);
  assert.ok(calls.some(([name, value]) => name === "setInfo" && (value as any).agentMd === "None"));
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
    gatewayId: "api_key/google",
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
  const metrics = { model: "openai/test", capabilities: [], promptTokens: 1, completionTokens: 0, cachedTokens: 0, totalTokens: 1, threadId: "test" };
  const notice = { level: "error" as const, message: "OpenAI usage (HTTP 429): retry later" };
  await app.handlePromptResult({ kind: "usage", metrics, notice });
  assert.deepEqual(calls.slice(-2), [["showUsage", metrics], ["showNotice", notice]]);
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

test("CubeApp routes gateway changes through the shared picker and runtime transaction", async () => {
  const { runtime, calls: runtimeCalls } = createRuntime();
  const { screen } = createScreen();
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });

  await app.handlePromptResult({
    kind: "gateways",
    request: {
      choices: [{
        gatewayId: "api_key/google",
        group: "api_key",
        provider: "google",
        configured: false,
      }],
    },
  });

  assert.deepEqual(runtimeCalls, [[
    "gateway.set",
    { draftId: "draft-1", model: { modelId: "google/new" } },
  ]]);
});

test("CubeApp attaches to an already mounted screen without mounting it twice", async () => {
  const { runtime } = createRuntime();
  const { screen, calls } = createScreen();
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });

  await app.start({ screenAlreadyMounted: true });

  assert.equal(calls.some((call) => call[0] === "mount"), false);
  assert.equal(calls.some((call) => call[0] === "startTerminal"), false);
  assert.equal(calls.filter((call) => call[0] === "setSubmitHandler").length, 1);
  await app.stop();
});

const createOnboarding = () => {
  const calls: unknown[][] = [];
  return {
    calls,
    mount: () => { calls.push(["mount"]); },
    stopTerminal: () => { calls.push(["stop"]); },
    showNotice: (notice: unknown) => { calls.push(["notice", notice]); },
    pickTrust: async () => true,
    pickGateway: async () => ({ draftId: "draft-1", model: { modelId: "google/new" } }),
    waitForRetry: async () => false,
  };
};

test("startup mounts onboarding before setup and only constructs chat after commit and runtime", async () => {
  const { runtime } = createRuntime();
  const { screen } = createScreen();
  const order: string[] = [];
  const onboarding = createOnboarding();
  onboarding.mount = () => { order.push("onboard"); };
  onboarding.stopTerminal = () => { order.push("leave-onboard"); };
  onboarding.pickGateway = async () => {
    order.push("picker");
    return { draftId: "draft-1", model: { modelId: "google/new" } };
  };
  screen.mount = () => { order.push("chat"); };
  let ready = false;
  let preparations = 0;
  const prepare = async () => {
    preparations++;
    return {
      readiness: { ready },
      permission: { trusted: true },
      gateway: { commitInitial: async () => { order.push("commit"); ready = true; } },
      start: async () => { order.push("runtime"); return runtime; },
    };
  };
  const launched = await startPreparedCube(prepare as never, () => screen, {
    onExitRequested: () => undefined,
  }, onboarding as never);
  assert.deepEqual(order, ["onboard", "picker", "commit", "runtime", "leave-onboard", "chat"]);
  assert.ok(launched);
  await launched.app.stop();
  assert.equal(preparations, 1, "onboarding must reuse the prepared bootstrap");
});

test("startup bypasses onboarding when persisted readiness is complete", async () => {
  const { runtime } = createRuntime();
  const { screen } = createScreen();
  const onboarding = createOnboarding();
  const launched = await startPreparedCube(async () => ({
    readiness: { ready: true },
    permission: { trusted: true },
    start: async () => runtime,
  }) as never, () => screen, { onExitRequested: () => undefined }, onboarding as never);
  assert.equal(onboarding.calls.some(([name]) => name === "mount"), false);
  assert.ok(launched);
  await launched.app.stop();
});

test("bootstrap failures are recoverable on onboarding without ever creating chat", async () => {
  const onboarding = createOnboarding();
  let retries = 0;
  onboarding.waitForRetry = async () => ++retries < 2;
  let prepared = 0;
  const launched = await startPreparedCube(async () => {
    prepared++;
    throw new Error("Invalid Cube authentication file.");
  }, () => { throw new Error("chat must not be constructed"); },
  { onExitRequested: () => undefined }, onboarding as never);
  assert.equal(launched, null);
  assert.equal(prepared, 2);
  assert.deepEqual(onboarding.calls.filter(([name]) => name === "notice"), [
    ["notice", { level: "error", message: "Invalid Cube authentication file." }],
    ["notice", { level: "error", message: "Invalid Cube authentication file." }],
  ]);
});

test("onboarding cancellation never starts a runtime or creates chat", async () => {
  const onboarding = { ...createOnboarding(), pickGateway: async () => null };
  const result = await startPreparedCube(async () => ({
    readiness: { ready: false }, gateway: {},
    permission: { trusted: true },
    start: async () => { throw new Error("runtime must not be started"); },
  }) as never, () => { throw new Error("chat must not be created"); },
  { onExitRequested: () => undefined }, onboarding as never);
  assert.equal(result, null);
});

test("CubeApp renders submitted user input before runtime submission settles", async () => {
  let resolveSubmit: ((result: PromptResult) => void) | undefined;
  const idle = { ...displayState("idle"), isRunning: false } as RuntimeDisplayState;
  const { runtime } = createRuntime(idle);
  runtime.prompt.submit = (_content, onDispatch) => {
    onDispatch?.(false);
    return new Promise<PromptResult>((resolve) => {
      resolveSubmit = resolve;
    });
  };
  const { screen, calls } = createScreen();
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });

  const pending = app.submitPrompt("hello");
  assert.deepEqual(calls[0], ["addUserMessage", "hello"]);
  resolveSubmit?.({ kind: "submitted" });
  await pending;
});

test("CubeApp stops working state and displays the provider error without credentials", async () => {
  const { runtime } = createRuntime();
  runtime.prompt.submit = async () => {
    throw new Error("HTTP 401 Bearer leaked-secret");
  };
  const { screen, calls } = createScreen();
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });

  await app.submitPrompt("hello");

  assert.equal(calls.filter((call) => call[0] === "workingIndicator.stop").length, 1);
  assert.deepEqual(calls.filter((call) => call[0] === "showNotice"), [[
    "showNotice",
    {
      level: "error",
      message: "HTTP 401 Bearer [Redacted]",
    },
  ]]);
  assert.equal(JSON.stringify(calls).includes("leaked-secret"), false);
});

test("CubeApp stops working state for error notices returned by runtime", async () => {
  const { runtime } = createRuntime();
  runtime.prompt.submit = async () => ({
    kind: "notice",
    notice: { level: "error", message: "Gateway unavailable." },
  });
  const { screen, calls } = createScreen();
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });

  await app.submitPrompt("hello");

  assert.equal(calls.filter((call) => call[0] === "workingIndicator.stop").length, 1);
});

test("CubeApp does not render slash commands as conversation user messages", async () => {
  const idle = { ...displayState("idle"), isRunning: false } as RuntimeDisplayState;
  const { runtime } = createRuntime(idle);
  runtime.prompt.submit = async () => ({
    kind: "models",
    gatewayId: "api_key/google",
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
  await app.start({ screenAlreadyMounted: true });

  app.handleRuntimeEvent({
    type: "tool_approval_required",
    toolCallId: "call-1",
    toolName: "mastra_workspace_execute_command",
    args: { command: "Get-Date" },
  } as never);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(approvals, [
    {
      target: undefined,
      toolCallId: "call-1",
      toolName: "mastra_workspace_execute_command",
      decision: "approve",
    },
  ]);
  await app.stop();
});

test("child approvals wait for explicit review without blocking main approval and stale targets cannot resume", async () => {
  const { runtime, approvals } = createRuntime();
  const { screen } = createScreen();
  const pending = new Map<string, SubagentApprovalRequest>();
  screen.addSubagentApproval = input => { pending.set(input.id, input); };
  screen.removeSubagentApproval = id => { pending.delete(id); };
  screen.cancelApproval = () => {};
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });
  await app.start({ screenAlreadyMounted: true });
  try {
    const first = { jobId: "child-a", runId: "run-a", toolCallId: "same-call" };
    const second = { jobId: "child-b", runId: "run-b", toolCallId: "same-call" };
    for (const target of [first, second]) app.handleRuntimeEvent({
      type: "subagent_interaction", target, agent: "worker", description: "Assigned task", directory: "D:/cube",
      event: { type: "tool_approval_required", toolName: "execute_command", toolCallId: "same-call", args: { command: "dir" } },
    } as never);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(approvals.length, 0, "background approvals must not open/resolve automatically");
    assert.equal(pending.size, 2);
    app.handleRuntimeEvent({ type: "tool_approval_required", toolName: "execute_command",
      toolCallId: "main-call", args: { command: "dir" } } as never);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(approvals[0]?.toolCallId, "main-call");
    pending.get("child-b:run-b:same-call")!.onDecision("approve");
    assert.deepEqual(approvals[1]?.target, second);
    const stale = pending.get("child-a:run-a:same-call");
    app.handleRuntimeEvent({ type: "subagent_interaction_cancelled", jobId: "child-a", runId: "run-a" } as never);
    stale!.onDecision("approve");
    assert.equal(approvals.length, 2);
    assert.equal(pending.size, 0);
  } finally { await app.stop(); }
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
  await app.start({ screenAlreadyMounted: true });

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
  await app.stop();
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
        message: "Provider is temporarily rate-limited",
      },
    ]],
  );
});

test("CubeApp displays a prompt sent after the previous turn ends during history persistence", async () => {
  let state = displayState("previous reply");
  const { runtime } = createRuntime(state);
  const { screen, queued, calls } = createScreen();
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });
  let releaseHistory!: () => void;
  let historyStarted!: () => void;
  const history = new Promise<void>((resolve) => { releaseHistory = resolve; });
  const entered = new Promise<void>((resolve) => { historyStarted = resolve; });
  let submissions = 0;
  const promptService = new PromptService(
    {} as never,
    {
      run: { isRunning: () => state.isRunning },
      followUp: async () => {
        submissions++;
        assert.equal(state.isRunning, false);
        state = {
          ...displayState("reply to ok"),
          isRunning: false,
        };
        app.handleRuntimeEvent({ type: "display_state_changed", displayState: state });
      },
    } as never,
    { ensureForPrompt: async () => "thread-1" } as never,
    { gateway: { readiness: async () => ({ ready: true }) } } as never,
    (callback) => callback(),
    async () => { historyStarted(); await history; },
  );
  runtime.prompt.submit = promptService.submit.bind(promptService);

  const pending = app.submitPrompt("ok");
  await entered;
  state = { ...state, isRunning: false };
  app.handleRuntimeEvent({ type: "display_state_changed", displayState: state });
  releaseHistory();
  await pending;

  assert.equal(submissions, 1);
  assert.deepEqual(queued, []);
  assert.deepEqual(calls.filter(([name]) => name === "addUserMessage"), [["addUserMessage", "ok"]]);
  assert.deepEqual(calls.filter(([name]) => name === "renderDisplayState").at(-1), ["renderDisplayState", state, false]);
});

test("CubeApp cancels queued prompts newest first before interrupting the active turn", async () => {
  const running = displayState("running");
  const { runtime, calls } = createRuntime(running);
  const nativeQueue: string[] = [];
  runtime.prompt.submit = async (content, onDispatch) => {
    onDispatch?.(true);
    nativeQueue.push(content);
    app.handleRuntimeEvent({ type: "display_state_changed", displayState: displayState("running", nativeQueue.length) });
    return { kind: "submitted" };
  };
  runtime.prompt.cancelLatestQueued = () => {
    const cancelled = nativeQueue.pop() ?? null;
    if (cancelled !== null) app.handleRuntimeEvent({ type: "display_state_changed", displayState: displayState("running", nativeQueue.length) });
    return cancelled;
  };
  const { screen, queued, calls: screenCalls } = createScreen();
  const app = new CubeApp(runtime, screen, { onExitRequested: () => undefined });

  await app.submitPrompt("first");
  await app.submitPrompt("second");
  assert.deepEqual(queued, ["first", "second"]);
  assert.equal(app.handleInterrupt(), true);
  assert.deepEqual(queued, ["first"]);
  assert.equal(screenCalls.some(([name]) => name === "addUserMessage"), false);
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
