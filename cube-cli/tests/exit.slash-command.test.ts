import assert from "node:assert/strict";
import test from "node:test";
import { createExitCommandHandler } from "../src/slash-commands/exit.slash-command.js";

test("runs graceful shutdown through the exit handler", async () => {
  let shutdowns = 0;
  const handler = createExitCommandHandler({
    shutdown: async () => { shutdowns += 1; },
  });

  await handler("");
  assert.equal(shutdowns, 1);
});
