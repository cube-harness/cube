import assert from "node:assert/strict";
import test from "node:test";
import { ActionDispatcher } from "../src/dispatcher.js";
import { createForkCommand } from "../src/commands/fork.command.js";
import type { CubeUIEvent } from "../src/contracts/ui.contract.js";

test("ForkCommand blocks execution when agent turn is active", async () => {
  const dispatcher = new ActionDispatcher();
  const events: CubeUIEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createForkCommand({
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
  const events: CubeUIEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createForkCommand({
    session: { thread: { getId: () => null } } as any,
    dispatcher,
    isTurnActive: () => false,
  });

  await handler("");
  const sysMsg = events.find((e) => e.type === "system:message") as any;
  assert.ok(sysMsg?.content?.includes("Cannot fork an empty session"));
});

test("ForkCommand clones and switches while native Session owns transcript restoration", async () => {
  let switchedTo = "";
  const dispatcher = new ActionDispatcher();
  const events: CubeUIEvent[] = [];
  dispatcher.subscribe((e) => events.push(e));

  const handler = createForkCommand({
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
      },
    } as any,
    dispatcher,
    isTurnActive: () => false,
  });

  await handler("Experiment Feature");
  assert.equal(switchedTo, "cloned-thread-2");

  const infoEvent = events.find((e) => e.type === "state:info") as any;
  assert.equal(infoEvent?.info?.threadId, "cloned-thread-2");

  const sysMsg = events.find((e) => e.type === "system:message") as any;
  assert.ok(sysMsg?.content?.includes('Forked thread into: cloned-thread-2 ("Experiment Feature")'));
});
