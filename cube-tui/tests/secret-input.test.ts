import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { SecretInput } from "../src/components/secret-input.js";

test("secret input never renders its value", () => {
  let submitted = "";
  const input = new SecretInput({
    title: "Google API key",
    onSubmit: (value) => { submitted = value; },
    onCancel: () => undefined,
  });
  input.handleInput("sk-secret-value");

  const lines = input.render(24);
  const visible = stripTerminalSequences(lines.join("\n"));
  assert.doesNotMatch(visible, /sk-secret-value/);
  assert.match(visible, /••••/);
  assert.equal(lines.every((line) => visibleWidth(line) <= 24), true);
  input.handleInput("\r");
  assert.equal(submitted, "sk-secret-value");
});

test("secret input can render an editable non-secret endpoint", () => {
  const input = new SecretInput({
    title: "Ollama endpoint",
    masked: false,
    initialValue: "http://127.0.0.1:11434",
    onSubmit: () => undefined,
    onCancel: () => undefined,
  });
  assert.match(stripTerminalSequences(input.render(80).join("\n")), /127\.0\.0\.1:11434/);
});
