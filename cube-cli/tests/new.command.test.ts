import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "@mastra/core/agent-controller";
import type { TuiApp } from "@cube/tui";
import { createNewCommandHandler } from "../src/commands/new.command.js";

const createMockSession = (overrides?: {
  isRunning?: boolean;
  onDetach?: () => void;
  onClearLock?: () => void;
}) => {
  return {
    run: {
      isRunning: () => overrides?.isRunning ?? false,
    },
    thread: {
      detachFromCurrent: () => overrides?.onDetach?.(),
      clearAndReleaseLock: async () => overrides?.onClearLock?.(),
    },
  } as unknown as Session;
};

const createMockApp = (overrides?: {
  onClearMessages?: () => void;
  onSetInfo?: (info: unknown) => void;
}) => {
  return {
    clearMessages: () => overrides?.onClearMessages?.(),
    setInfo: (info: unknown) => overrides?.onSetInfo?.(),
  } as unknown as TuiApp;
};

test("NewCommand blocks execution when agent turn is active", async () => {
  const messages: string[] = [];
  let detached = false;

  const session = createMockSession({
    isRunning: true,
    onDetach: () => {
      detached = true;
    },
  });
  const app = createMockApp();

  const handler = createNewCommandHandler({
    session,
    getApp: () => app,
    showMessage: (msg) => messages.push(msg),
  });

  await handler("");
  assert.equal(detached, false);
  assert.match(messages[0], /Cannot start new thread while an agent turn is active/);
});

test("NewCommand detaches thread, clears UI messages, and updates info", async () => {
  const messages: string[] = [];
  let detached = false;
  let cleared = false;
  let rotated = false;

  const session = createMockSession({
    isRunning: false,
    onDetach: () => {
      detached = true;
    },
  });
  const app = createMockApp({
    onClearMessages: () => {
      cleared = true;
    },
  });

  const handler = createNewCommandHandler({
    session,
    getApp: () => app,
    showMessage: (msg) => messages.push(msg),
    onNewThread: () => {
      rotated = true;
    },
  });

  await handler("");
  assert.equal(detached, true);
  assert.equal(cleared, true);
  assert.equal(rotated, true);
  assert.match(messages[0], /Started a new conversation thread/);
});
