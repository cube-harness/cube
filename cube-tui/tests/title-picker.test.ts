import assert from "node:assert/strict";
import test from "node:test";
import { TitlePickerComponent, formatTerminalTitle } from "../src/components/title-picker.js";

test("TitlePickerComponent renders within width limit and displays checkboxes", () => {
  let selectedIds: string[] = [];
  let cancelled = false;

  const picker = new TitlePickerComponent({
    currentValues: {
      model: "gemini-2.5-flash",
      threadId: "test-thread",
      workspace: "/test/path",
      status: "Idle",
    },
    onSelect: (ids) => {
      selectedIds = ids;
    },
    onCancel: () => {
      cancelled = true;
    },
  });

  const lines = picker.render(80);
  assert.ok(lines.length > 0);
  const fullText = lines.join("\n");
  assert.match(fullText, /Configure Terminal Title/);
  assert.match(fullText, /Active Model/);
  assert.match(fullText, /Workspace Directory/);
  assert.match(fullText, /Thread Title \/ ID/);
  assert.match(fullText, /Preview:/);
  assert.match(fullText, /Space/);
});

test("TitlePickerComponent toggles item selection with Space and submits with Enter", () => {
  let selectedResult: string[] | null = null;

  const picker = new TitlePickerComponent({
    items: [
      { id: "item1", label: "Item 1", description: "Desc 1", selected: true },
      { id: "item2", label: "Item 2", description: "Desc 2", selected: false },
    ],
    onSelect: (ids) => {
      selectedResult = ids;
    },
    onCancel: () => {},
  });

  // Initially: item1 selected, item2 not selected
  assert.deepEqual(picker.getSelectedIds(), ["item1"]);

  // Press Space on item1 -> prevented because at least 1 option must remain selected
  picker.handleInput(" ");
  assert.deepEqual(picker.getSelectedIds(), ["item1"]);

  // Navigate Down -> highlights item2
  picker.handleInput("\x1b[B");

  // Press Space -> toggles item2 on (now both item1 and item2 selected)
  picker.handleInput(" ");
  assert.deepEqual(picker.getSelectedIds(), ["item1", "item2"]);

  // Navigate Up -> highlights item1
  picker.handleInput("\x1b[A");

  // Press Space -> toggles item1 off (item2 remains selected)
  picker.handleInput(" ");
  assert.deepEqual(picker.getSelectedIds(), ["item2"]);

  // Press Enter -> submits
  picker.handleInput("\r");
  assert.deepEqual(selectedResult, ["item2"]);
});

test("TitlePickerComponent supports search filtering and Escape cancellation", () => {
  let cancelled = false;

  const picker = new TitlePickerComponent({
    items: [
      { id: "alpha", label: "Alpha Option", description: "First", selected: true },
      { id: "beta", label: "Beta Option", description: "Second", selected: true },
    ],
    onSelect: () => {},
    onCancel: () => {
      cancelled = true;
    },
  });

  // Filter by typing 'Beta'
  picker.handleInput("B");
  picker.handleInput("e");
  picker.handleInput("t");
  picker.handleInput("a");

  const lines = picker.render(80);
  const rendered = lines.join("\n");
  assert.match(rendered, /Beta Option/);
  assert.doesNotMatch(rendered, /Alpha Option/);

  // First Escape -> clears search query
  picker.handleInput("\x1b");
  assert.equal(cancelled, false);

  // Second Escape -> cancels picker
  picker.handleInput("\x1b");
  assert.equal(cancelled, true);
});

test("formatTerminalTitle formats fields with custom or default separator", () => {
  const values = {
    model: "gemini-2.5-flash",
    workspace: "D:/cube",
    threadId: "thread_123",
    status: "Busy",
  };

  const defaultFormatted = formatTerminalTitle(["model", "workspace", "threadId"], values);
  assert.equal(defaultFormatted, "gemini-2.5-flash | D:/cube | thread_123");

  const customFormatted = formatTerminalTitle(["status", "model"], values, " • ");
  assert.equal(customFormatted, "Busy • gemini-2.5-flash");

  const emptyFormatted = formatTerminalTitle([], values);
  assert.equal(emptyFormatted, "gemini-2.5-flash");
});
