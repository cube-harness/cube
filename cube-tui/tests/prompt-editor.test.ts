import assert from "node:assert/strict";
import test from "node:test";
import { PromptEditor } from "../src/components/prompt-editor.js";
import { installCubeKeybindings } from "../src/keybindings.js";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { appTheme } from "../src/themes/app.theme.js";

test.beforeEach(() => {
  installCubeKeybindings();
});

test("PromptEditor navigates history with Up and Down arrows", () => {
  const tui = {
    requestRender() {},
  } as any;

  const editor = new PromptEditor({
    tui,
    onSubmit: () => undefined,
    initialHistory: ["prompt 1", "prompt 2", "prompt 3"],
  });

  // Initial state is empty
  assert.equal(editor.getText(), "");

  // Up arrow -> "prompt 3"
  editor.handleInput("\u001b[A");
  assert.equal(editor.getText(), "prompt 3");

  // Up arrow -> "prompt 2"
  editor.handleInput("\u001b[A");
  assert.equal(editor.getText(), "prompt 2");

  // Up arrow -> "prompt 1"
  editor.handleInput("\u001b[A");
  assert.equal(editor.getText(), "prompt 1");

  // Up arrow at top remains "prompt 1"
  editor.handleInput("\u001b[A");
  assert.equal(editor.getText(), "prompt 1");

  // Down arrow -> "prompt 2"
  editor.handleInput("\u001b[B");
  assert.equal(editor.getText(), "prompt 2");

  // Down arrow -> "prompt 3"
  editor.handleInput("\u001b[B");
  assert.equal(editor.getText(), "prompt 3");

  // Down arrow -> restores empty draft
  editor.handleInput("\u001b[B");
  assert.equal(editor.getText(), "");
});

test("PromptEditor preserves user draft when navigating history", () => {
  const tui = {
    requestRender() {},
  } as any;

  const editor = new PromptEditor({
    tui,
    onSubmit: () => undefined,
    initialHistory: ["first command"],
  });

  editor.setText("work in progress");

  // Up arrow loads history
  editor.handleInput("\u001b[A");
  assert.equal(editor.getText(), "first command");

  // Down arrow restores previous draft
  editor.handleInput("\u001b[B");
  assert.equal(editor.getText(), "work in progress");
});

test("PromptEditor adds submitted prompts to history", () => {
  const tui = {
    requestRender() {},
  } as any;

  const submissions: string[] = [];
  const editor = new PromptEditor({
    tui,
    onSubmit: (text) => submissions.push(text),
  });

  editor.setText("new prompt from user");
  editor.handleInput("\r");

  assert.deepEqual(submissions, ["new prompt from user"]);
  assert.equal(editor.getText(), "");

  // Now Up arrow should bring up "new prompt from user"
  editor.handleInput("\u001b[A");
  assert.equal(editor.getText(), "new prompt from user");
});

test("PromptEditor submits slash commands as unchanged raw text", () => {
  const submissions: string[] = [];
  const editor = new PromptEditor({
    tui: { requestRender() {} } as any,
    onSubmit: (text) => submissions.push(text),
  });
  editor.setText("/model openrouter/test --effort high");
  editor.handleInput("\r");
  assert.deepEqual(submissions, ["/model openrouter/test --effort high"]);
});

test("PromptEditor cancels queued prompts newest first while draining stays FIFO", () => {
  const editor = new PromptEditor({
    tui: { requestRender() {} } as any,
    onSubmit: () => undefined,
  });
  editor.enqueueQueuedPrompt("first");
  editor.enqueueQueuedPrompt("second");
  editor.enqueueQueuedPrompt("third");

  assert.equal(editor.popQueuedPrompt(), "third");
  assert.deepEqual(editor.dequeueQueuedPrompts(2), ["first", "second"]);
});

test("PromptEditor uses the shared card and a display-only placeholder without losing input or autocomplete", async () => {
  const originalColorLevel = chalk.level;
  chalk.level = 3;
  const submissions: string[] = [];
  const editor = new PromptEditor({
    tui: { terminal: { rows: 24 }, requestRender() {} } as any,
    onSubmit: text => { submissions.push(text); },
    slashCommands: [{ name: "/model", description: "Choose model" }],
  });
  editor.focused = true;
  try {
    const empty = editor.render(80);
    assert.equal(empty.length, 3);
    assert.match(stripTerminalSequences(empty.join("\n")), /❯\s+Ask Cube/);
    assert.ok(empty.some(line => line.includes(CURSOR_MARKER)));
    const rgb = appTheme.surface.background.slice(1).match(/../g)!.map(hex => parseInt(hex, 16));
    const background = `\x1b[48;2;${rgb.join(";")}m`;
    const placeholderRow = empty.find(line => line.includes("Ask Cube"))!;
    const afterCursor = placeholderRow.split("\x1b[0m")[1]!;
    assert.ok(afterCursor.startsWith(background), "card background must resume after the cursor reset");
    assert.match(afterCursor, /Ask Cube/);
    assert.doesNotMatch(stripTerminalSequences(empty.join("\n")), /[╭╮╰╯│─]/);
    editor.handleInput("\r");
    assert.deepEqual(submissions, []);
    assert.equal(editor.getText(), "");
    editor.setText("first ─ line\nsecond ↓ line");
    const entered = stripTerminalSequences(editor.render(80).join("\n"));
    assert.match(entered, /first ─ line/);
    assert.match(entered, /second ↓ line/);
    assert.doesNotMatch(entered, /Ask Cube/);
    for (const width of [1, 4, 10, 20, 80]) {
      assert.ok(editor.render(width).every(line => visibleWidth(line) <= width));
    }
    editor.setText("");
    editor.handleInput("/");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.match(stripTerminalSequences(editor.render(80).join("\n")), /Choose model/);
    editor.handleInput("\t");
    assert.equal(editor.getText().trim(), "/model");
    editor.handleInput("\r");
    assert.deepEqual(submissions, ["/model"]);
  } finally {
    editor.focused = false;
    chalk.level = originalColorLevel;
  }
});

test("PromptEditor stops cursor blink renders while blinking is disabled", () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let tick: (() => void) | undefined;
  const timer = { unref() {} } as NodeJS.Timeout;
  globalThis.setInterval = ((callback: () => void) => {
    tick = callback;
    return timer;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = (() => undefined) as typeof globalThis.clearInterval;

  let renders = 0;
  const editor = new PromptEditor({
    tui: { requestRender: () => { renders += 1; } } as any,
    onSubmit: () => undefined,
  });

  try {
    editor.focused = true;
    const rendersBeforeTick = renders;
    tick?.();
    assert.equal(renders, rendersBeforeTick + 1);

    editor.setCursorBlinking(false);
    const rendersAfterDisable = renders;
    tick?.();
    assert.equal(renders, rendersAfterDisable);

    editor.setCursorBlinking(true);
    const rendersBeforeEnabledTick = renders;
    tick?.();
    assert.equal(renders, rendersBeforeEnabledTick + 1);
  } finally {
    editor.focused = false;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
