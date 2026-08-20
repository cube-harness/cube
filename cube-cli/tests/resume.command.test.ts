import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "@mastra/core/agent-controller";
import type { TuiApp } from "@cube/tui";
import { createResumeCommandHandler } from "../src/commands/resume.command.js";

const createMockSession = (overrides?: {
  isRunning?: boolean;
  activeId?: string | null;
  threads?: Array<{ id: string; title: string }>;
  messages?: Array<{ role: string; content: string }>;
  onSwitch?: (id: string) => void;
}) => {
  return {
    run: {
      isRunning: () => overrides?.isRunning ?? false,
    },
    thread: {
      getId: () => overrides?.activeId ?? null,
      list: async () => overrides?.threads ?? [],
      switch: async ({ threadId }: { threadId: string }) => {
        overrides?.onSwitch?.(threadId);
      },
      listMessages: async () => overrides?.messages ?? [],
    },
  } as unknown as Session;
};

const createMockApp = (overrides?: {
  pickerResult?: string | null;
  onSetMessages?: (msgs: unknown[]) => void;
  onSetInfo?: (info: unknown) => void;
}) => {
  return {
    openThreadPicker: async () => overrides?.pickerResult ?? null,
    setMessages: (msgs: unknown[]) => overrides?.onSetMessages?.(msgs),
    setInfo: (info: unknown) => overrides?.onSetInfo?.(info),
  } as unknown as TuiApp;
};

test("ResumeCommand blocks execution when agent turn is active", async () => {
  const messages: string[] = [];
  const session = createMockSession({ isRunning: true });
  const app = createMockApp();

  const handler = createResumeCommandHandler({
    session,
    getApp: () => app,
    showMessage: (msg) => messages.push(msg),
  });

  await handler("");
  assert.match(messages[0], /Cannot switch threads while an agent turn is active/);
});

test("ResumeCommand notifies when no threads exist in workspace", async () => {
  const messages: string[] = [];
  const session = createMockSession({ threads: [] });
  const app = createMockApp();

  const handler = createResumeCommandHandler({
    session,
    getApp: () => app,
    showMessage: (msg) => messages.push(msg),
  });

  await handler("");
  assert.match(messages[0], /No previous threads found/);
});

test("ResumeCommand switches thread and rehydrates message list on selection", async () => {
  const messages: string[] = [];
  let switchedToId = "";
  let updatedInfo: unknown = null;
  let rehydratedMessages: unknown[] = [];

  const session = createMockSession({
    activeId: "thread-1",
    threads: [
      { id: "thread-1", title: "Thread 1" },
      { id: "thread-2", title: "Thread 2" },
    ],
    messages: [
      { role: "user", content: "Hello from thread 2" },
      { role: "assistant", content: "Hi there!" },
    ],
    onSwitch: (id) => {
      switchedToId = id;
    },
  });

  const app = createMockApp({
    pickerResult: "thread-2",
    onSetMessages: (msgs) => {
      rehydratedMessages = msgs;
    },
    onSetInfo: (info) => {
      updatedInfo = info;
    },
  });

  const handler = createResumeCommandHandler({
    session,
    getApp: () => app,
    showMessage: (msg) => messages.push(msg),
  });

  await handler("");
  assert.equal(switchedToId, "thread-2");
  assert.deepEqual(updatedInfo, { threadId: "thread-2" });
  assert.equal(rehydratedMessages.length, 2);
  assert.match(messages[0], /Switched to thread: thread-2/);
});
