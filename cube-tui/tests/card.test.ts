import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { Card } from "../src/components/card.js";
import { SecretInput } from "../src/components/secret-input.js";

test("picker card preserves input and focus while containing its child at narrow widths", () => {
  const submitted: string[] = [];
  const input = new SecretInput({
    title: "API key", onSubmit: value => submitted.push(value), onCancel: () => undefined,
  });
  const card = new Card(input);
  card.focused = true;
  card.handleInput("private-key");
  assert.equal(input.focused, true);
  assert.ok(card.render(60).some(line => line.includes(CURSOR_MARKER)));
  for (const width of [1, 4, 20, 60, 100]) {
    const lines = card.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(!lines.join("\n").includes("private-key"));
  }
  card.handleInput("\r");
  assert.deepEqual(submitted, ["private-key"]);
  card.focused = false;
  assert.equal(input.focused, false);
});
