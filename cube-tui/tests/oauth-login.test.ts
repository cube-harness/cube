import assert from "node:assert/strict";
import test from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { getOsc8LinkAtColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { OAuthLoginComponent } from "../src/components/oauth-login.js";
import { appTheme } from "../src/themes/app.theme.js";

const tui = { requestRender: () => undefined } as unknown as TUI;

test("OAuth login keeps exactly one visible clickable URL", async t => {
  t.mock.method(appTheme.markdown, "link", (text: string) => "\x1b[4m" + text + "\x1b[24m");
  let resolve!: (value: { draftId: string }) => void;
  const completion = new Promise<{ draftId: string }>((done) => { resolve = done; });
  const component = new OAuthLoginComponent({
    tui,
    authorizationUrl: "https://auth.openai.com/authorize?test=1",
    completion,
    cancel: async () => undefined,
    onComplete: () => undefined,
    onCancel: () => undefined,
    onError: (error) => { throw error; },
  });

  t.after(() => component.handleInput("\x1b"));
  const lines = component.render(80);
  const visible = stripTerminalSequences(lines.join("\n"));
  assert.equal(visible.split("https://auth.openai.com/authorize?test=1").length - 1, 1);
  assert.equal(lines.every((line) => visibleWidth(line) <= 80), true);
  const linked = lines.find(line => line.includes("\x1b]8;"))!;
  assert.equal(getOsc8LinkAtColumn(linked, 0), "https://auth.openai.com/authorize?test=1");
  for (const width of [22, 50, 100]) {
    const wrapped = component.render(width).filter(line => line.includes("\x1b]8;"));
    assert.equal(wrapped.map(line => stripTerminalSequences(line).trimEnd()).join(""),
      "https://auth.openai.com/authorize?test=1");
    for (const line of wrapped) {
      assert.equal(getOsc8LinkAtColumn(line, 0), "https://auth.openai.com/authorize?test=1");
      assert.ok(visibleWidth(line) <= width);
    }
  }
  const close = linked.search(/\x1b\]8;;(?:\x07|\x1b\\)/);
  assert.ok(close >= 0, "URL must close its hyperlink before padding");
  assert.ok(linked.indexOf("\x1b[24m") < close, "underline must end with the URL, before padding");
  assert.match(stripTerminalSequences(linked.slice(close)), /^\s*$/);
  assert.doesNotMatch(visible, /Expires in/);
  resolve({ draftId: "draft" });
  await completion;
});

test("OAuth login Escape cancels even if the browser was closed", async () => {
  let cancelled = 0;
  const component = new OAuthLoginComponent({
    tui,
    authorizationUrl: "https://auth.openai.com/authorize",
    completion: new Promise(() => undefined),
    cancel: async () => {
      cancelled += 1;
      throw new Error("callback already closed");
    },
    onComplete: () => undefined,
    onCancel: () => { cancelled += 1; },
    onError: () => undefined,
  });
  component.handleInput("\x1b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 2);
  assert.deepEqual(component.render(80), []);
});
test("device countdown uses absolute server expiry and completion remains successful beyond expiry", async t => {
  let now = 1000000;
  t.mock.method(Date, "now", () => now);
  let complete!: (value: string) => void;
  let successes = 0;
  const completion = new Promise<string>(resolve => { complete = resolve; });
  const component = new OAuthLoginComponent({
    tui, providerName: "xAI", authorizationUrl: "https://auth.x.ai/activate", expiresAt: now + 1800000,
    completion, cancel: async () => undefined, onComplete: () => { successes++; },
    onCancel: () => assert.fail("must not cancel"), onError: error => { throw error; },
  });
  assert.match(stripTerminalSequences(component.render(80).join("\n")), /Expires in 30:00/);
  now += 65000;
  assert.match(stripTerminalSequences(component.render(80).join("\n")), /Expires in 28:55/);
  assert.equal(component.render(22).every(line => visibleWidth(line) <= 22), true);
  complete("signed in");
  await completion;
  now += 1800000;
  component.render(80);
  assert.equal(successes, 1);
});
