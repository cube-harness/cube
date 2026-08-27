import assert from "node:assert/strict";
import test from "node:test";
import { getKeybindings } from "@earendil-works/pi-tui";
import { ApprovalPicker } from "../src/components/approval-picker.js";
import { ThreadPickerOverlay } from "../src/components/thread-picker.js";
import {
  createCubeKeybindings,
  installCubeKeybindings,
} from "../src/keybindings.js";

test.afterEach(() => {
  installCubeKeybindings();
});

test("Cube installs one registry containing pi-tui and Cube actions", () => {
  installCubeKeybindings();
  const bindings = getKeybindings();

  assert.equal(bindings.matches("\r", "tui.select.confirm"), true);
  assert.equal(bindings.matches("y", "cube.approval.approve"), true);
  assert.equal(bindings.matches("\x14", "cube.transcript.toggle"), true);
  assert.equal(bindings.matches("\x1b", "cube.turn.interrupt"), true);
  assert.equal(bindings.matches("\x03", "cube.app.exit"), true);
  assert.equal(bindings.matches("\x03", "cube.turn.interrupt"), false);
});

test("approval shortcuts come from the central registry", () => {
  installCubeKeybindings({
    "cube.approval.approve": "a",
  });
  let decision: string | undefined;
  const picker = new ApprovalPicker({
    toolName: "mastra_workspace_execute_command",
    args: { command: "git status" },
    onDecision: (value) => {
      decision = value;
    },
  });

  assert.match(picker.render(100).join("\n"), /Yes, proceed \(a\)/);

  picker.handleInput("y");
  assert.equal(decision, undefined);

  picker.handleInput("a");
  assert.equal(decision, "approve");
});

test("picker navigation delegates remapped select keys to pi-tui SelectList", () => {
  installCubeKeybindings({
    "tui.select.down": "j",
    "tui.select.confirm": "l",
  });
  let selected: string | undefined;
  const picker = new ThreadPickerOverlay({
    threads: [
      { id: "one", title: "One", updatedAt: "2026-08-24", isActive: true },
      { id: "two", title: "Two", updatedAt: "2026-08-24", isActive: false },
    ],
    onSelect: (threadId) => {
      selected = threadId;
    },
    onCancel: () => undefined,
  });

  picker.handleInput("j");
  picker.handleInput("l");

  assert.equal(selected, "two");
});

test("factory reports conflicting user overrides", () => {
  const bindings = createCubeKeybindings({
    "cube.approval.approve": "a",
    "cube.approval.decline": "a",
  });

  assert.deepEqual(bindings.getConflicts(), [
    {
      key: "a",
      keybindings: ["cube.approval.approve", "cube.approval.decline"],
    },
  ]);
});
