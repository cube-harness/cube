import assert from "node:assert/strict";
import test from "node:test";
import { PromptEditor, createPromptAutocomplete } from "../src/components/prompt-editor.js";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("completion preserves mentions and quoted paths without fd, and rejects outside roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "cube-completion-"));
  try {
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace); await mkdir(outside);
    await writeFile(join(workspace, "hello world.md"), "not injected");
    await writeFile(join(outside, "secret.md"), "outside");
    await symlink(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
    let enabled = true;
    const provider = createPromptAutocomplete(workspace, [{ name: "/model", description: "Model" }], async () => [{
      name: "review", description: "Review", path: "skill", source: "project", enabled, userInvocable: true,
    }]);
    const suggest = (text: string) => provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal });
    const skill = (await suggest("Use $rev"))!;
    assert.equal(skill.items[0]!.value, "$review");
    assert.equal(provider.applyCompletion(["Use $rev later"], 0, 8, skill.items[0]!, skill.prefix).lines[0], "Use $review  later");
    enabled = false;
    assert.equal(await suggest("$rev"), null);
    const file = (await suggest("Read @hello"))!;
    assert.equal(file.items[0]!.value, '@"hello world.md"');
    assert.equal(provider.applyCompletion(["Read @hello"], 0, 11, file.items[0]!, file.prefix).lines[0], 'Read @"hello world.md" ');
    assert.equal((await suggest("/mod"))!.items[0]!.value, "model");
    for (const text of ["@../outside/", "@escape/", "@~/", `@${outside}/`]) assert.equal(await suggest(text), null, text);
    assert.ok(!(await suggest("@"))!.items.some((item) => item.label === "escape/"));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("PromptEditor uses the shared card and a display-only placeholder without losing input or autocomplete", async () => {
  const originalColorLevel = chalk.level;
  chalk.level = 3;
  const submissions: string[] = [];
  const editor = new PromptEditor({
    tui: { terminal: { rows: 24 }, requestRender() {} } as any,
    onSubmit: text => { submissions.push(text); },
    slashCommands: [
      { name: "/model", description: "Choose model" },
      { name: "/skills", description: "Manage skills" },
    ],
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
    const completed = editor.render(80);
    const suggestionIndex = completed.findIndex(line => line.includes("Choose model"));
    const inputIndex = completed.findIndex(line => line.includes(CURSOR_MARKER));
    assert.ok(suggestionIndex >= 0 && suggestionIndex < inputIndex, "autocomplete must be above the input card");
    assert.match(stripTerminalSequences(completed[suggestionIndex]!), /^ {2}❯ \/model\s+Choose model/);
    // Primary foreground + black background, inverted: primary surface with black text.
    assert.ok(completed[suggestionIndex]!.includes(appTheme.ui.primary("x").split("x")[0]!));
    assert.ok(completed[suggestionIndex]!.includes("\x1b[40m\x1b[7m"));
    const unselected = completed.find(line => line.includes("Manage skills"))!;
    assert.match(stripTerminalSequences(unselected), /^ {4}\/skills/);
    assert.doesNotMatch(unselected, /\x1b\[(?:4[0-8]|7)m|\x1b\[48[;:]/);
    assert.ok(completed[inputIndex]!.includes(background), "input keeps its surface");
    assert.doesNotMatch(stripTerminalSequences(completed.join("\n")), /→/);
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
