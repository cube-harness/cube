import assert from "node:assert/strict";
import test from "node:test";
import { createForkCommandHandler } from "../src/commands/fork.command.js";

test("ForkCommand blocks execution when agent turn is active", async () => {
  let message = "";
  const handler = createForkCommandHandler({
    session: {} as any,
    getApp: () => undefined,
    showMessage: (msg) => {
      message = msg;
    },
    isTurnActive: () => true,
  });

  await handler("");
  assert.ok(message.includes("Cannot fork thread while an agent turn is active"));
});

test("ForkCommand notifies when no active thread exists", async () => {
  let message = "";
  const handler = createForkCommandHandler({
    session: { thread: { getId: () => null } } as any,
    getApp: () => ({} as any),
    showMessage: (msg) => {
      message = msg;
    },
    isTurnActive: () => false,
  });

  await handler("");
  assert.ok(message.includes("Cannot fork an empty session"));
});

test("ForkCommand clones active thread, switches, rehydrates messages, and updates InfoBox", async () => {
  let message = "";
  let switchedTo = "";
  let updatedInfo: any;
  let rehydratedMessages: any[] = [];

  const fakeApp = {
    setMessages: (msgs: any[]) => {
      rehydratedMessages = msgs;
    },
    setInfo: (info: any) => {
      updatedInfo = info;
    },
  };

  const handler = createForkCommandHandler({
    session: {
      thread: {
        getId: () => "source-thread-1",
        clone: async ({ sourceThreadId, title }: { sourceThreadId?: string; title?: string }) => ({
          id: "cloned-thread-2",
          title: title || "Forked Thread",
        }),
        switch: async ({ threadId }: { threadId: string }) => {
          switchedTo = threadId;
        },
        listMessages: async () => [
          { role: "user", content: "hello world" },
          { role: "assistant", content: { format: 2, parts: [{ type: "text", text: "hi there!" }] } },
        ],
      },
    } as any,
    getApp: () => fakeApp as any,
    showMessage: (msg) => {
      message = msg;
    },
    isTurnActive: () => false,
  });

  await handler("Experiment Feature");
  assert.equal(switchedTo, "cloned-thread-2");
  assert.equal(updatedInfo.threadId, "cloned-thread-2");
  assert.equal(rehydratedMessages.length, 2);
  assert.equal(rehydratedMessages[0].content, "hello world");
  assert.equal(rehydratedMessages[1].content, "hi there!");
  assert.ok(message.includes('Forked thread into: cloned-thread-2 ("Experiment Feature")'));
});
