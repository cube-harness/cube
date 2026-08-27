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

  const actions: any[] = [];
  const editor = new PromptEditor({
    tui,
    onAction: (action) => actions.push(action),
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
    onAction: () => {},
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

  const actions: any[] = [];
  const editor = new PromptEditor({
    tui,
    onAction: (action) => actions.push(action),
  });

  editor.setText("new prompt from user");
  editor.handleInput("\r");

  assert.equal(actions.length, 1);
  assert.equal(actions[0].content, "new prompt from user");
  assert.equal(editor.getText(), "");

  // Now Up arrow should bring up "new prompt from user"
  editor.handleInput("\u001b[A");
  assert.equal(editor.getText(), "new prompt from user");
});
