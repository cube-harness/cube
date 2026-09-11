import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { GatewayDraft, GatewaySelection } from "@cube/runtime";
import { GatewayPickerComponent, GatewaySetupComponent, type GatewaySetupOptions } from "../src/components/gateway-picker.js";

const choices = [
  { gatewayId: "api_key/google" as const, group: "api_key" as const, provider: "google", configured: true },
  { gatewayId: "api_key/openrouter" as const, group: "api_key" as const, provider: "openrouter", configured: false },
  { gatewayId: "oauth/openai" as const, group: "oauth" as const, provider: "openai", configured: false },
];

test("OAuth risk is an inline picker note, not a confirmation step or chat message", () => {
  for (const provider of ["anthropic", "google"] as const) {
  let selected: unknown;
  const picker = new GatewayPickerComponent({
    choices: [{ gatewayId: `oauth/${provider}`, provider, group: "oauth", configured: false }],
    onSelect: value => { selected = value; }, onCancel: () => undefined,
  });
  picker.handleInput("\r");
  const text = stripTerminalSequences(picker.render(50).join("\n"));
  assert.match(text, /Risk Notice:/);
  assert.match(text, /own risk/);
  assert.equal(picker.render(25).every(line => visibleWidth(line) <= 25), true);
  picker.handleInput("\r");
  assert.deepEqual(selected, { gatewayId: `oauth/${provider}`, replace: true });
  }
});

test("Grok Build starts device login, displays its code, then opens models without extra Enter", async () => {
  let complete!: (draft: GatewayDraft) => void;
  const completion = new Promise<GatewayDraft>(resolve => { complete = resolve; });
  let logins = 0;
  const picker = new GatewaySetupComponent({
    onNotice: () => undefined,
    tui: { requestRender: () => undefined } as unknown as TUI,
    request: { choices: [{ gatewayId: "oauth/xai", group: "oauth", provider: "xai", configured: false }] },
    gateway: { discardDraft: () => undefined, beginGrokLogin: async () => {
      logins++;
      return { authorizationUrl: "https://auth.x.ai/activate", userCode: "ABCD-EFGH", completion, expiresAt: Date.now() + 1800000, cancel: async () => undefined };
    } } as GatewaySetupOptions["gateway"],
    onSelect: () => undefined, onCancel: () => undefined, onError: error => { throw error; },
  });
  picker.handleInput("\r");
  assert.match(stripTerminalSequences(picker.render(60).join("\n")), /xAI/);
  picker.handleInput("\r");
  await new Promise(resolve => setImmediate(resolve));
  const view = stripTerminalSequences(picker.render(60).join("\n"));
  try {
    assert.match(view, /ABCD-EFGH/);
    assert.match(view, /https:\/\/auth.x.ai\/activate/);
    assert.doesNotMatch(view, /OpenAI/);
    assert.equal(picker.render(25).every(line => visibleWidth(line) <= 25), true);
    complete({ draftId: "grok", gatewayId: "oauth/xai", catalog: { updatedAt: "", providers: { xai: { name: "xAI", models: [{
      modelId: "xai/grok-build", name: "Grok Build", reasoning: false, tool_call: true, structured_output: false,
      attachment: false, open_weights: false, limit: { context: 500000, output: 64000 }, modalities: { input: ["text"], output: ["text"] },
    }] } } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logins, 1);
    assert.match(stripTerminalSequences(picker.render(60).join("\n")), /xai\/grok-build/);
    assert.doesNotMatch(picker.render(60).join("\n"), /auth.x.ai/);
  } finally { picker.handleInput("\x1b"); }
});

test("API picker shows native provider names and keeps Coding Plans in API key", () => {
  for (const [provider, label] of [["anthropic", "Anthropic"], ["moonshotai", "Moonshot"],
    ["zai-coding-plan", "Z.AI Coding Plan"], ["alibaba-coding-plan", "Alibaba Coding Plan"],
    ["huggingface", "Hugging Face"]] as const) {
    let selected: unknown;
    const picker = new GatewayPickerComponent({
      choices: [{ gatewayId: `api_key/${provider}`, provider, group: "api_key", configured: false }],
      onSelect: value => { selected = value; }, onCancel: () => undefined,
    });
    picker.handleInput("\r");
    assert.ok(stripTerminalSequences(picker.render(60).join("\n")).includes(label));
    picker.handleInput("\r");
    assert.deepEqual(selected, { gatewayId: `api_key/${provider}`, replace: true });
  }
});

test("gateway picker navigates group, provider, and stored credential", () => {
  let result: unknown;
  const picker = new GatewayPickerComponent({
    choices,
    onSelect: (value) => { result = value; },
    onCancel: () => undefined,
  });

  assert.match(picker.render(50).join("\n"), /API Key/);
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

test("cancelling while login starts handles the late completion rejection", async () => {
  type Login = Awaited<ReturnType<GatewaySetupOptions["gateway"]["beginOpenAILogin"]>>;
  let open!: (login: Login) => void;
  const starting = new Promise<Login>((resolve) => { open = resolve; });
  let reject!: (error: Error) => void;
  const completion = new Promise<never>((_resolve, fail) => { reject = fail; });
  let cancelled = 0;
  const picker = new GatewaySetupComponent({
    onNotice: () => undefined,
    tui: { requestRender: () => undefined } as unknown as TUI,
    request: { choices: choices.filter(choice => choice.group === "oauth") },
    gateway: { beginOpenAILogin: () => starting } as GatewaySetupOptions["gateway"],
    onSelect: () => assert.fail("cancelled login cannot select a model"),
    onCancel: () => { cancelled += 1; },
    onError: () => assert.fail("cancellation must not render an error"),
  });
  picker.handleInput("\r");
  picker.handleInput("\r");
  picker.handleInput("\x03");
  open({ authorizationUrl: "https://auth.openai.com/authorize", completion,
    cancel: async () => { reject(new Error("login cancelled")); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1);
});

test("successful account login replaces the URL with the model picker without extra Enter", async () => {
  let complete!: (draft: GatewayDraft) => void;
  const completion = new Promise<GatewayDraft>(resolve => { complete = resolve; });
  const draft: GatewayDraft = { draftId: "signed-in", gatewayId: "oauth/openai",
    catalog: { updatedAt: "2026-09-06T00:00:00Z", providers: { openai: {
      name: "OpenAI", models: [{ modelId: "openai/gpt-5.5", name: "GPT-5.5", reasoning: false,
        tool_call: true, structured_output: true, attachment: false, open_weights: false,
        limit: { context: 128000, output: 8192 }, modalities: { input: ["text"], output: ["text"] } }],
    } } } };
  let logins = 0;
  let selected: GatewaySelection | undefined;
  const picker = new GatewaySetupComponent({
    onNotice: () => undefined,
    tui: { requestRender: () => undefined } as unknown as TUI,
    request: { choices: choices.filter(choice => choice.group === "oauth") },
    gateway: { beginOpenAILogin: async () => {
      logins += 1;
      return { authorizationUrl: "https://auth.openai.com/authorize", completion, cancel: async () => undefined };
    } } as GatewaySetupOptions["gateway"],
    onSelect: value => { selected = value; }, onCancel: () => undefined,
    onError: error => { throw error; },
  });
  picker.handleInput("\r");
  picker.handleInput("\r");
  await new Promise(resolve => setImmediate(resolve));
  const loginView = stripTerminalSequences(picker.render(80).join("\n"));
  complete(draft);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(logins, 1);
  assert.match(loginView, /https:\/\/auth.openai.com\/authorize/);
  assert.doesNotMatch(picker.render(80).join("\n"), /auth.openai.com/);
  assert.match(picker.render(80).join("\n"), /openai\/gpt-5\.5/);
  assert.equal(selected, undefined);
  assert.doesNotMatch(picker.render(80).join("\n"), /\(Current\)/);
  picker.handleInput("\r");
  assert.deepEqual(selected, { draftId: "signed-in", model: { modelId: "openai/gpt-5.5" } });
});
test("configured OAuth is used directly; switching accounts requires logout before login", () => {
  const removed: string[] = [];
  const selected: unknown[] = [];
  const picker = new GatewayPickerComponent({
    choices: choices.map(choice => ({ ...choice, configured: true })), initialGroup: "oauth", onRemove: id => removed.push(id),
    onSelect: value => selected.push(value), onCancel: () => undefined,
  });
  picker.handleInput("\x04");
  assert.match(stripTerminalSequences(picker.render(80).join("\n")), /Logout/);
  picker.handleInput("\r");
  assert.deepEqual(removed, []);
  picker.handleInput("\x04");
  picker.handleInput("\x1b[B");
  picker.handleInput("\r");
  assert.deepEqual(removed, ["oauth/openai"]);
  for (const provider of ["openai", "xai", "anthropic", "google"] as const) {
    const configured = new GatewayPickerComponent({
      choices: [{ gatewayId: `oauth/${provider}`, group: "oauth", provider, configured: true }],
      initialGroup: "oauth", onSelect: value => selected.push(value), onCancel: () => undefined,
    });
    configured.handleInput("\r");
    assert.deepEqual(selected.at(-1), { gatewayId: `oauth/${provider}`, replace: false });
  }
  const login = new GatewayPickerComponent({
    choices, initialGroup: "oauth", onRemove: id => removed.push(id),
    onSelect: value => selected.push(value), onCancel: () => undefined,
  });
  login.handleInput("\r");
  assert.deepEqual(selected.at(-1), { gatewayId: "oauth/openai", replace: true });
});
