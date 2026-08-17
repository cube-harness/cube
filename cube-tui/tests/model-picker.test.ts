import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ModelPicker } from "../src/components/model-picker.js";

test("marks the current model and filters by typed text", () => {
  const picker = new ModelPicker({
    models: [
      { id: "ollama/qwen2.5:7b" },
      { id: "google/gemini-3.6-flash", reasoningEfforts: ["low", "high"] },
    ],
    currentModel: "ollama/qwen2.5:7b",
  });

  assert.match(picker.render(80).join("\n"), /ollama\/qwen2\.5:7b.*current/s);

  for (const character of "google") picker.handleInput(character);

  assert.equal(picker.getSelectedModel(), "google/gemini-3.6-flash");
});

test("renders warnings without exceeding the available width", () => {
  const width = 24;
  const picker = new ModelPicker({
    models: [{ id: "google/gemini-3.6-flash" }],
    currentModel: "google/gemini-3.6-flash",
    warning: "Ollama is unavailable because the local server refused the connection",
  });

  const lines = picker.render(width);

  assert.equal(lines.some((line) => line.includes("Ollama")), true);
  assert.equal(lines.every((line) => visibleWidth(line) <= width), true);
});
