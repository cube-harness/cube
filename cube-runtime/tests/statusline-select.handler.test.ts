import assert from "node:assert/strict";
import test from "node:test";
import { CubeHome, ConfigStore } from "@cube/workspace";
import { ActionDispatcher } from "../src/dispatcher.js";
import { createStatusLineSelectHandler } from "../src/handlers/statusline-select.handler.js";

test("StatusLineSelectHandler persists status_line to config.yaml", async () => {
  const home = CubeHome();
  const configStore = ConfigStore(home);
  const initialConfig = await configStore.read();

  const dispatcher = new ActionDispatcher();
  const events: any[] = [];
  dispatcher.subscribe((e) => events.push(e));

  let appliedStatusLine: string[] | undefined;
  const handler = createStatusLineSelectHandler({
    home,
    dispatcher,
    onStatusLineApplied: (s) => {
      appliedStatusLine = s;
    },
  });

  const newStatusLine = ["threadId", "workspace", "model", "status"];
  await handler(newStatusLine);

  assert.deepEqual(appliedStatusLine, newStatusLine);
  const updatedConfig = await configStore.read();
  assert.deepEqual(updatedConfig.status_line, newStatusLine);

  // Restore initial config
  await configStore.update((c) => ({
    ...c,
    status_line: initialConfig.status_line,
  }));
});
