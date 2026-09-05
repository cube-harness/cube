import assert from "node:assert/strict";
import test from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { OAuthLoginComponent } from "../src/components/oauth-login.js";

const tui = { requestRender: () => undefined } as unknown as TUI;

test("OAuth login keeps exactly one visible clickable URL", async () => {
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

  const lines = component.render(80);
  const visible = stripTerminalSequences(lines.join("\n"));
  assert.equal(visible.split("https://auth.openai.com/authorize?test=1").length - 1, 1);
  assert.equal(lines.every((line) => visibleWidth(line) <= 80), true);
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
});
