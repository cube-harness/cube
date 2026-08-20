import assert from "node:assert/strict";
import test from "node:test";
import { Key } from "@earendil-works/pi-tui";
import { ThreadPickerOverlay } from "../src/components/thread-picker.js";

test("ThreadPickerOverlay renders within width limit", () => {
  const overlay = new ThreadPickerOverlay({
    threads: [
      { id: "thread-1", title: "First conversation", updatedAt: new Date().toISOString(), isActive: true },
      { id: "thread-2", title: "Second conversation", updatedAt: new Date().toISOString(), isActive: false },
    ],
    onSelect: () => {},
    onCancel: () => {},
  });

  const lines = overlay.render(80);
  assert.equal(lines.length > 0, true);
  for (const line of lines) {
    assert.equal(line.length <= 150, true); // ANSI escaped string
  }
});

test("ThreadPickerOverlay triggers onSelect when Enter is pressed", () => {
  let selected = "";
  const overlay = new ThreadPickerOverlay({
    threads: [
      { id: "thread-abc", title: "Test conversation", updatedAt: new Date().toISOString(), isActive: false },
    ],
    onSelect: (id) => {
      selected = id;
    },
    onCancel: () => {},
  });

  overlay.handleInput("\r");
  assert.equal(selected, "thread-abc");
});

test("ThreadPickerOverlay triggers onCancel when Escape is pressed", () => {
  let cancelled = false;
  const overlay = new ThreadPickerOverlay({
    threads: [
      { id: "thread-abc", title: "Test conversation", updatedAt: new Date().toISOString(), isActive: false },
    ],
    onSelect: () => {},
    onCancel: () => {
      cancelled = true;
    },
  });

  overlay.handleInput("\x1b");
  assert.equal(cancelled, true);
});
