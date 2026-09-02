#!/usr/bin/env node
import { createCubeRuntime } from "@cube/runtime";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { CubeApp } from "./app.js";
import { ChatScreen } from "./screens/chat.screen.js";

export const startTui = async (): Promise<void> => {
  const runtime = await createCubeRuntime();
  const preference = runtime.preference.get();
  const model = runtime.model.current();
  const screen = new ChatScreen({
    tui: new TuiMainScreen(new ProcessTerminal()),
    basePath: runtime.workspaceRoot,
    initialHistory: await runtime.getHistory(),
    slashCommands: runtime.suggestions,
    statusLine: preference.statusLine,
    initialInfo: {
      model: `${model.modelId}${
        model.reasoningEffort && model.reasoningEffort !== "none"
          ? ` (${model.reasoningEffort})`
          : ""
      }`,
      workspace: runtime.workspaceRoot,
      agentMd: "AGENT.md (active)",
      threadId: runtime.thread.current() ?? "new thread",
    },
  });

  let app: CubeApp;
  let exitPromise: Promise<void> | undefined;
  const exit = (): Promise<void> => {
    exitPromise ??= (async () => {
      await app.stop();
      await runtime.shutdown();
      process.exit(0);
    })();
    return exitPromise;
  };

  app = new CubeApp(runtime, screen, { onExitRequested: exit });
  process.once("SIGTERM", () => void exit());
  process.on("SIGINT", () => void app.handleExit());
  await app.start();
};

startTui().catch((error: unknown) => {
  console.error("Fatal TUI Error:", error);
  process.exit(1);
});
