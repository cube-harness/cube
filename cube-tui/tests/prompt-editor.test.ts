import assert from "node:assert/strict";
import test from "node:test";
import { PromptEditor } from "../src/components/prompt-editor.js";
import { installCubeKeybindings } from "../src/keybindings.js";

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
