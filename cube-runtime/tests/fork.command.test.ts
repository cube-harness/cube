import assert from "node:assert/strict";
import test from "node:test";
import { ActionDispatcher } from "../src/dispatcher.js";
import { createForkCommandHandler } from "../src/commands/fork.command.js";
import type { CubeEvent } from "../src/contracts/events.contract.js";

test("ForkCommand blocks execution when agent turn is active", async () => {
  const dispatcher = new ActionDispatcher();
  const events: CubeEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createForkCommandHandler({
    session: {} as any,
    dispatcher,
    isTurnActive: () => true,
  });

  await handler("");
  const sysMsg = events.find((e) => e.type === "system:message") as any;
  assert.ok(sysMsg?.content?.includes("Cannot fork thread while an agent turn is active"));
});

test("ForkCommand notifies when no active thread exists", async () => {
  const dispatcher = new ActionDispatcher();
  const events: CubeEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createForkCommandHandler({
    session: { thread: { getId: () => null } } as any,
    dispatcher,
    isTurnActive: () => false,
  });

  await handler("");
  const sysMsg = events.find((e) => e.type === "system:message") as any;
  assert.ok(sysMsg?.content?.includes("Cannot fork an empty session"));
});

test("ForkCommand clones active thread, switches, and emits messages:set & state:info", async () => {
  let switchedTo = "";
  const dispatcher = new ActionDispatcher();
  const events: CubeEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

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
    dispatcher,
    isTurnActive: () => false,
  });

  await handler("Experiment Feature");
  assert.equal(switchedTo, "cloned-thread-2");

  const msgSetEvent = events.find((e) => e.type === "messages:set") as any;
  assert.ok(msgSetEvent);
  assert.equal(msgSetEvent.messages.length, 2);
  assert.equal(msgSetEvent.messages[0].content, "hello world");
  assert.equal(msgSetEvent.messages[1].content, "hi there!");

  const infoEvent = events.find((e) => e.type === "state:info") as any;
  assert.equal(infoEvent?.info?.threadId, "cloned-thread-2");

  const sysMsg = events.find((e) => e.type === "system:message") as any;
  assert.ok(sysMsg?.content?.includes('Forked thread into: cloned-thread-2 ("Experiment Feature")'));
});
