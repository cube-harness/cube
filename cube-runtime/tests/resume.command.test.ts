import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "@cube/agent";
import { ActionDispatcher } from "../src/dispatcher.js";
import { createResumeCommandHandler } from "../src/commands/resume.command.js";
import type { CubeEvent } from "../src/contracts/events.contract.js";

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

test("ResumeCommand blocks execution when agent turn is active", async () => {
  const session = createMockSession({ isRunning: true });
  const dispatcher = new ActionDispatcher();
  const events: CubeEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createResumeCommandHandler({
    session,
    dispatcher,
  });

  await handler("");
  const sysMsg = events.find((e) => e.type === "system:message") as any;
  assert.match(sysMsg?.content, /Cannot switch threads while an agent turn is active/);
});

test("ResumeCommand notifies when no threads exist in workspace", async () => {
  const session = createMockSession({ threads: [] });
  const dispatcher = new ActionDispatcher();
  const events: CubeEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createResumeCommandHandler({
    session,
    dispatcher,
  });

  await handler("");
  const sysMsg = events.find((e) => e.type === "system:message") as any;
  assert.match(sysMsg?.content, /No previous threads found/);
});

test("ResumeCommand emits dialog:thread_picker event", async () => {
  const session = createMockSession({
    activeId: "thread-1",
    threads: [
      { id: "thread-1", title: "Thread 1" },
      { id: "thread-2", title: "Thread 2" },
    ],
  });

  const dispatcher = new ActionDispatcher();
  const events: CubeEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createResumeCommandHandler({
    session,
    dispatcher,
  });

  await handler("");
  const dialogEvent = events.find((e) => e.type === "dialog:thread_picker") as any;
  assert.ok(dialogEvent);
  assert.equal(dialogEvent.threads.length, 2);
});
