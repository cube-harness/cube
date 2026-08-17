import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ModelConfigPicker } from "../src/components/model-config-picker.js";

test("preselects the current effort and returns it on Enter", () => {
  const picker = new ModelConfigPicker({
    modelId: "google/gemini-3.6-flash",
    efforts: ["minimal", "low", "medium", "high"],
    currentEffort: "medium",
  });
  let selected: string | undefined;
  picker.onSelect = (effort) => {
    selected = effort;
  };

  picker.handleInput("\r");

  assert.equal(selected, "medium");
});

test("Escape returns to the previous selection step", () => {
  const picker = new ModelConfigPicker({
    modelId: "openai/gpt-5.1",
    efforts: ["none", "low", "medium", "high"],
  });
  let backedOut = false;
  picker.onBack = () => {
    backedOut = true;
  };

  picker.handleInput("\x1b");

  assert.equal(backedOut, true);
});

test("config picker truncates every rendered line", () => {
  const picker = new ModelConfigPicker({
    modelId: "openrouter/a-provider/with-an-extremely-long-model-name",
    efforts: ["minimal", "low", "medium", "high"],
    warning: "A very long partial catalog warning that must remain inline",
  });

  assert.equal(
    picker.render(22).every((line) => visibleWidth(line) <= 22),
    true,
  );
});
