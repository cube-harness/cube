#!/usr/bin/env node
import { openExternalUrl, prepareCubeRuntime } from "@cube/runtime";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { copyToClipboard } from "./clipboard.js";
import { startPreparedCube, type PreparedCube } from "./app.js";
import { ChatScreen } from "./screens/chat.screen.js";
import { OnBoardScreen } from "./screens/on-board.screen.js";

export const startTui = async (): Promise<void> => {
  const tui = new TuiAltScreen(new ProcessTerminal(), undefined, undefined, {
    copySelection: copyToClipboard,
    openUrl: (url) => {
      if (/^https?:\/\//i.test(url)) void openExternalUrl(url).catch(() => undefined);
    },
  });
  const onboarding = new OnBoardScreen(tui);
  const createScreen = (bootstrap: Awaited<ReturnType<typeof prepareCubeRuntime>>) => {
    const model = bootstrap.readiness.ready ? bootstrap.readiness.model : undefined;
    return new ChatScreen({
      tui,
      basePath: bootstrap.workspaceRoot,
      initialHistory: bootstrap.history,
      slashCommands: bootstrap.suggestions,
      statusLine: bootstrap.preference.statusLine,
      initialInfo: {
        model: model
          ? `${model.modelId}${
              model.reasoningEffort && model.reasoningEffort !== "none"
                ? ` (${model.reasoningEffort})`
                : ""
            }`
          : "Not configured",
        workspace: bootstrap.workspaceRoot,
        threadId: "new thread",
      },
    });
  };

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

  launched = await startPreparedCube(
    prepareCubeRuntime,
    createScreen,
    { onExitRequested: exit },
    onboarding,
  );
  if (!launched) return;
  process.once("SIGTERM", () => void exit());
  process.on("SIGINT", () => void launched?.app.handleExit());
};

startTui().catch((error: unknown) => {
  console.error("Fatal TUI Error:", error);
  process.exit(1);
});
