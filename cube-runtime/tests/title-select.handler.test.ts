import assert from "node:assert/strict";
import test from "node:test";
import { CubeHome, ConfigStore } from "@cube/workspace";
import { ActionDispatcher } from "../src/dispatcher.js";
import { createTitleSelectHandler } from "../src/handlers/title-select.handler.js";

test("TitleSelectHandler persists app_title to config.yaml", async () => {
  const home = CubeHome();
  const configStore = ConfigStore(home);
  const initialConfig = await configStore.read();

  const dispatcher = new ActionDispatcher();
  const events: any[] = [];
  dispatcher.subscribe((e) => events.push(e));

  let appliedTitle: string[] | undefined;
  const handler = createTitleSelectHandler({
    home,
    dispatcher,
    onTitleApplied: (t) => {
      appliedTitle = t;
    },
  });

  const newTitle = ["threadId", "workspace", "model"];
  await handler(newTitle);

  assert.deepEqual(appliedTitle, newTitle);
  const updatedConfig = await configStore.read();
  assert.deepEqual(updatedConfig.app_title, newTitle);

  // Restore initial config
  await configStore.update((c) => ({
    ...c,
    app_title: initialConfig.app_title,
  }));
});
