import assert from "node:assert/strict";
import test from "node:test";
import { StatusLinePickerComponent } from "../src/components/statusline-picker.js";
import { Footer } from "../src/components/footer.js";

test("StatusLinePickerComponent renders within width limit and displays checkboxes", () => {
  let selectedIds: string[] = [];
  let cancelled = false;

  const picker = new StatusLinePickerComponent({
    currentValues: {
      model: "gemini-2.5-flash",
      workspace: "/test/path",
      agentMd: "AGENT.md (active)",
      threadId: "test-thread",
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
  assert.match(fullText, /Configure Footer Status Line/);
  assert.match(fullText, /Active Model/);
  assert.match(fullText, /Workspace Directory/);
  assert.match(fullText, /AGENT\.md Status/);
  assert.match(fullText, /Thread Title/);
  assert.match(fullText, /Thread ID/);
  assert.match(fullText, /Preview:/);
  assert.match(fullText, /Space/);
});

test("StatusLinePickerComponent toggles item selection with Space and submits with Enter", () => {
  let selectedResult: string[] | null = null;

  const picker = new StatusLinePickerComponent({
    items: [
      { id: "item1", label: "Item 1", description: "Desc 1", selected: true },
      { id: "item2", label: "Item 2", description: "Desc 2", selected: false },
    ],
    onSelect: (ids) => {
      selectedResult = ids;
    },
    onCancel: () => {},
  });

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

test("preserves custom selection order and appends newly selected items to the end", () => {
  const picker = new StatusLinePickerComponent({
    initialSelection: ["threadId", "workspace"],
    currentValues: {
      model: "gemini-2.5-flash",
      workspace: "D:/cube",
      agentMd: "AGENT.md",
      threadId: "thread_123",
      status: "Idle",
    },
    onSelect: () => {},
    onCancel: () => {},
  });

  // Initially: threadId, then workspace
  assert.deepEqual(picker.getSelectedIds(), ["threadId", "workspace"]);

  // Model is at index 0 in list. Press Space to toggle model ON
  picker.handleInput(" ");
  // Model must be appended to the END of selection, NOT jumping to the front!
  assert.deepEqual(picker.getSelectedIds(), ["threadId", "workspace", "model"]);

  const lines = picker.render(100);
  const fullText = lines.join("\n");
  assert.match(fullText, /thread_123[\s\S]*D:\/cube[\s\S]*gemini-2\.5-flash/);
});

test("Footer right-aligns output and respects custom statusLine", () => {
  const footer = new Footer(
    {
      model: "gemini-3.7-flash",
      workspace: "D:/cube",
      agentMd: "AGENT.md",
      threadId: "thread-123",
    },
    ["model", "workspace"],
  );

  const lines = footer.render(80);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /gemini-3\.7-flash • D:\/cube$/);
  assert.ok(lines[0].startsWith(" "));
});
