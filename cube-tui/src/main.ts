#!/usr/bin/env node
import { prepareCubeRuntime } from "@cube/runtime";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { startPreparedCube, type PreparedCube } from "./app.js";
import { ChatScreen } from "./screens/chat.screen.js";

export const startTui = async (): Promise<void> => {
  const preflight = await prepareCubeRuntime();
  const model = preflight.readiness.ready ? preflight.readiness.model : undefined;
  const screen = new ChatScreen({
    tui: new TuiMainScreen(new ProcessTerminal()),
    basePath: preflight.workspaceRoot,
    initialHistory: preflight.history,
    slashCommands: preflight.suggestions,
    statusLine: preflight.preference.statusLine,
    initialInfo: {
      model: model
        ? `${model.modelId}${
            model.reasoningEffort && model.reasoningEffort !== "none"
              ? ` (${model.reasoningEffort})`
              : ""
          }`
        : "Not configured",
      workspace: preflight.workspaceRoot,
      agentMd: "AGENT.md (active)",
      threadId: "new thread",
    },
  });

  let launched: PreparedCube | null = null;
  let exitPromise: Promise<void> | undefined;
  const exit = (): Promise<void> => {
    exitPromise ??= (async () => {
      await launched?.app.stop();
      await launched?.runtime.shutdown();
      process.exit(0);
    })();
    return exitPromise;
  };

  launched = await startPreparedCube(preflight, screen, { onExitRequested: exit });
  if (!launched) return;
  process.once("SIGTERM", () => void exit());
  process.on("SIGINT", () => void launched?.app.handleExit());
};

startTui().catch((error: unknown) => {
  console.error("Fatal TUI Error:", error);
  process.exit(1);
});
