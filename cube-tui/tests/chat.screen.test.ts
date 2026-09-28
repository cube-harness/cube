import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen, type Component, type Terminal, type TUI } from "@earendil-works/pi-tui";
import type { RuntimeDisplayState } from "@cube/runtime";
import { ChatScreen } from "../src/screens/chat.screen.js";
import { renderUsageBoxToString } from "../src/components/usage-box.js";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

test("subscription status renders provider windows and keeps missing quota distinct from zero", () => {
  const metrics = {
    model: "openai/account-model", promptTokens: 42, completionTokens: 5, totalTokens: 47, threadId: "test",
    subscription: { provider: "OpenAI", plan: "pro", limits: [
      { name: "Codex", windows: [
        { name: "Primary", usedPercent: 36, windowSeconds: 18000, resetsAt: 1800000000 },
        { name: "Secondary", usedPercent: 100, windowSeconds: 604800, resetsAt: 1800604800 },
      ] },
      { name: "Account model", windows: [{ name: "Primary" }] },
      { name: "Unavailable quota", windows: [] },
    ] },
  };
  const text = stripTerminalSequences(renderUsageBoxToString(metrics));
  assert.match(text, /5h limit\s+: \[█{13}░{7}\] 64% left/);
  assert.match(text, /Weekly limit\s+: \[░{20}\] 0% left/);
  const reset = new Date(1800000000 * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  assert.ok(text.includes(`(resets ${reset})`));
  const weeklyDate = new Date(1800604800 * 1000);
  const weeklyReset = weeklyDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) +
    ` on ${weeklyDate.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" })}`;
  assert.ok(text.split("\n").find(line => line.includes("Weekly limit"))?.includes(`(resets ${weeklyReset})`));
  assert.match(text, /Primary limit\s+: No usage data/);
  assert.match(text, /Quota\s+: No data/);
  assert.match(text, /\(resets unknown\)/);
  const rows = ["Thread ID", "Cache", "Context Window", "5h limit", "Weekly limit"];
  assert.deepEqual([...rows].sort((a, b) => text.indexOf(a) - text.indexOf(b)), rows);
  metrics.subscription.limits[0]!.windows[0]!.usedPercent = 0;
  assert.match(stripTerminalSequences(renderUsageBoxToString(metrics)), /5h limit\s+: \[█{20}\] 100% left/);
  assert.match(text, /unknown \(42 tokens used\)/);
  for (const width of [40, 80, 120]) {
    assert.ok(renderUsageBoxToString(metrics, width).split("\n").every(line => visibleWidth(line) <= width));
  }
  const google = stripTerminalSequences(renderUsageBoxToString({ ...metrics, subscription: {
    provider: "Google", plan: "AI Pro", limits: [{ name: "gemini-test", windows: [{
      name: "Requests", usedPercent: 35.9999999, resetsAt: 1800604800,
    }] }],
  } }, 120));
  assert.match(google, /gemini-test/);
  assert.match(google, /64% left/);
  assert.ok(google.includes(`on ${weeklyDate.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" })}`));
  const balance = stripTerminalSequences(renderUsageBoxToString({ ...metrics, subscription: {
    provider: "xAI", limits: [{ name: "Prepaid balance", windows: [{ name: "Balance", remaining: 25, unit: "credits" }] }],
  } }));
  assert.match(balance, /Prepaid balance\s+: 25 credits left/);
  assert.doesNotMatch(balance, /100% left|█/);
  assert.doesNotMatch(balance, /resets unknown/);
  const fullWeekly = stripTerminalSequences(renderUsageBoxToString({ ...metrics, subscription: {
    provider: "xAI", limits: [
      { name: "Grok Build", windows: [{ name: "Weekly", windowSeconds: 604800, usedPercent: 0, resetsAt: 1800604800 }] },
      { name: "On-demand", windows: [{ name: "Credits", remaining: 0, unit: "credits", resetsAt: 1800604800 }] },
    ],
  } }));
  assert.ok(fullWeekly.split("\n").find(line => line.includes("Weekly limit"))?.includes(`(resets ${weeklyReset})`));
  assert.match(fullWeekly, /On-demand\s+: 0 credits left/);
  assert.doesNotMatch(fullWeekly, /SuperGrok|Grok Build|Credits\s+:/);
  assert.match(stripTerminalSequences(renderUsageBoxToString({ ...metrics, subscription: { provider: "Anthropic", limits: [] } })), /Quota\s+: No data/);
});

test("unknown model limits show token usage without invented capacity or percentage", () => {
  const rendered = renderUsageBoxToString({
    model: "openai/account-only", capabilities: [], capabilitiesComplete: false,
    promptTokens: 42, completionTokens: 5, totalTokens: 47, threadId: "test",
  }, 100);
  assert.match(rendered, /unknown \(42 tokens used\)/);
  assert.doesNotMatch(rendered, /128K|NaN|Infinity|%/);
});

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

test("fullscreen chat keeps the editor docked through scrolling, resize, picker and new", async () => {
  let output = "";
  let input: (data: string) => void = () => undefined;
  const terminal: Terminal = {
    columns: 120, rows: 40, kittyProtocolActive: false,
    start: (onInput) => { input = onInput; }, stop: () => undefined, drainInput: async () => undefined,
    write: (data) => { output += data; },
    moveBy: () => undefined, hideCursor: () => undefined, showCursor: () => undefined,
    clearLine: () => undefined, clearFromCursor: () => undefined, clearScreen: () => undefined,
    setTitle: () => undefined, setProgress: () => undefined,
  };
  const tui = new TuiAltScreen(terminal);
  const screen = new ChatScreen({ tui, basePath: "D:\\cube" });
  let rows: string[] = [];
  const render = () => {
    output = "";
    tui.renderNow();
    for (const match of output.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;\d+H|$)/g)) {
      rows[Number(match[1]) - 1] = stripTerminalSequences(match[2]!);
    }
    rows.length = terminal.rows;
    return rows.findIndex((line) => line?.includes("Ask Cube"));
  };
  screen.mount({ onSubmit: () => undefined });
  tui.start();
  try {
    assert.equal(render(), 37);
    const info = rows.findIndex((line) => line?.includes("WorkSpace Information"));
    assert.ok(info > 0 && info < 36);
    assert.ok(rows[info]!.indexOf("╭") > 0);
    screen.addUserMessage(Array.from({ length: 100 }, (_, i) => `history-${i}`).join("\n"));
    assert.equal(render(), 37);
    const bottom = rows.slice(0, 36).join("\n");
    tui.scrollToTop();
    assert.equal(render(), 37);
    assert.notEqual(rows.slice(0, 36).join("\n"), bottom);
    assert.match(rows.join("\n"), /history-0/);
    terminal.columns = 60;
    terminal.rows = 24;
    rows = [];
    assert.equal(render(), 21);
    assert.ok(rows.every((line) => visibleWidth(line) <= 60));
    const picker = screen.pickThread([]);
    assert.equal(render(), -1);
    input("\x1b");
    assert.equal(await picker, null);
    screen.clearConversation();
    assert.equal(render(), 21);
    assert.match(rows.join("\n"), /WorkSpace Information/);
  } finally {
    screen.stopTerminal();
  }
});

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

test("ChatScreen reuses one gateway flow for stored configuration and model selection", async () => {
  const fake = createTui();
  const screen = new ChatScreen({ tui: fake.tui, basePath: "D:\\cube" });
  screen.mount({ onSubmit: async () => undefined });
  const gateway = {
    createStoredDraft: async () => ({
      draftId: "draft-1",
      gatewayId: "api_key/google",
      catalog: {
        updatedAt: "2026-09-05T00:00:00.000Z",
        providers: {
          google: {
            name: "Google",
            models: [{
              modelId: "google/gemini-test",
              name: "Gemini Test",
              reasoning: false,
              tool_call: true,
              structured_output: true,
              attachment: false,
              open_weights: false,
              limit: { context: 128_000, output: 8_192 },
              modalities: { input: ["text"], output: ["text"] },
            }],
          },
        },
      },
      currentModelId: "google/gemini-test",
    }),
  };

  const pending = screen.pickGateway(gateway as never, {
    choices: [{
      gatewayId: "api_key/google",
      group: "api_key",
      provider: "google",
      configured: true,
    }],
  });
  let picker = fake.getFocused() as Component & { handleInput(data: string): void };
  picker.handleInput("\r");
  picker.handleInput("\r");
  picker.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  picker = fake.getFocused() as Component & { handleInput(data: string): void };
  picker.handleInput("\r");

  assert.deepEqual(await pending, {
    draftId: "draft-1",
    model: { modelId: "google/gemini-test" },
  });
  assert.equal(fake.getFocused(), screen.promptEditor);
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
