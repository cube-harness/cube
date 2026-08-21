import assert from "node:assert/strict";
import test from "node:test";
import { KeyHint } from "../src/components/key-hint.js";

test("KeyHint renders formatted key hint labels", () => {
  const hint = new KeyHint([
    { key: "↑/↓", label: "Navigate" },
    { key: "Enter", label: "Select" },
    { key: "Esc", label: "Cancel" },
  ]);

  const lines = hint.render(80);
  assert.equal(lines.length > 0, true);
  assert.ok(lines[0]?.includes("Navigate"));
  assert.ok(lines[0]?.includes("Select"));
  assert.ok(lines[0]?.includes("Cancel"));
});
