import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { Session } from "@cube/agent";
import { Home, HistoryStore } from "@cube/workspace";
import { ActionDispatcher } from "../src/dispatcher.js";
import { createPromptHandler } from "../src/handlers/prompt.handler.js";

test("submits a new thread prompt through the native follow-up queue inside its log context", async () => {
  let activeThreadId: string | null = null;
  let contextThreadId: string | null = null;
  let sentInsideContext = false;

  const session = {
    thread: {
      getId: () => activeThreadId,
      create: async ({ id }: { id: string }) => {
        activeThreadId = id;
      },
    },
    followUp: async () => {
      sentInsideContext = contextThreadId === activeThreadId;
    },
    sendMessage: async () => {
      throw new Error("prompt handler bypassed the native follow-up queue");
    },
  } as unknown as Session;

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cube-prompt-test-"));
  const home = new Home({ cubeHome: tmpDir });
  await home.ensure();

  const handler = createPromptHandler({
    home,
    session,
    dispatcher: new ActionDispatcher(),
    getPlannedThreadId: () => "thread-new",
    setPlannedThreadId: () => undefined,
    runWithThreadLogContext: async (callback: () => Promise<void>) => {
      contextThreadId = activeThreadId;
      try {
        await callback();
      } finally {
        contextThreadId = null;
      }
    },
  });

  try {
    await handler("hello");
    assert.equal(sentInsideContext, true);

    // Allow background fire-and-forget append to finish disk I/O
    await new Promise((r) => setTimeout(r, 50));

    const history = await HistoryStore(home).read();
    assert.equal(history.length, 1);
    assert.equal(history[0]?.text, "hello");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
