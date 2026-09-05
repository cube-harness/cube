import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { GatewayPickerComponent } from "../src/components/gateway-picker.js";

const choices = [
  { gatewayId: "api_key/google" as const, group: "api_key" as const, provider: "google", configured: true },
  { gatewayId: "api_key/openrouter" as const, group: "api_key" as const, provider: "openrouter", configured: false },
  { gatewayId: "subscription/openai" as const, group: "subscription" as const, provider: "openai", configured: true },
];

test("gateway picker navigates group, provider, and stored credential", () => {
  let result: unknown;
  const picker = new GatewayPickerComponent({
    choices,
    onSelect: (value) => { result = value; },
    onCancel: () => undefined,
  });

  assert.match(picker.render(50).join("\n"), /API key/);
  picker.handleInput("\r");
  assert.match(picker.render(50).join("\n"), /Google/);
  picker.handleInput("\r");
  assert.match(picker.render(50).join("\n"), /Use saved/);
  picker.handleInput("\r");

  assert.deepEqual(result, { gatewayId: "api_key/google", replace: false });
  assert.equal(picker.render(30).every((line) => visibleWidth(line) <= 30), true);
});

test("gateway picker can replace stored configuration and cancel each level", () => {
  const results: unknown[] = [];
  let cancelled = false;
  const picker = new GatewayPickerComponent({
    choices,
    onSelect: (value) => results.push(value),
    onCancel: () => { cancelled = true; },
  });

  picker.handleInput("\r");
  picker.handleInput("\r");
  picker.handleInput("\x1b[B");
  picker.handleInput("\r");
  assert.deepEqual(results, [{ gatewayId: "api_key/google", replace: true }]);

  const cancelPicker = new GatewayPickerComponent({
    choices,
    onSelect: () => undefined,
    onCancel: () => { cancelled = true; },
  });
  cancelPicker.handleInput("\r");
  cancelPicker.handleInput("\x1b");
  assert.equal(cancelled, false);
  cancelPicker.handleInput("\x1b");
  assert.equal(cancelled, true);
});
