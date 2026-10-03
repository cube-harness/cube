#!/usr/bin/env node
import { checkCubeUpdate, prepareCubeUpdate, openExternalUrl, prepareCubeRuntime, type RuntimeNotice } from "@cube/runtime";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { copyToClipboard } from "./clipboard.js";
import { startPreparedCube, type PreparedCube } from "./app.js";
import { ChatScreen } from "./screens/chat.screen.js";
import { OnBoardScreen } from "./screens/on-board.screen.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { PetTerminal } from "./components/pet.js";

export const startTui = async (): Promise<void> => {
  const tui = new TuiAltScreen(new PetTerminal(), undefined, undefined, {
    copySelection: copyToClipboard,
    openUrl: (url) => {
      if (/^https?:\/\//i.test(url)) void openExternalUrl(url).catch(() => undefined);
    },
  });
  const onboarding = new OnBoardScreen(tui, join(homedir(), ".cube", "cache", "tui-pet", "cube"));
  const updateNotices: RuntimeNotice[] = [];
  const updateError = process.env.CUBE_UPDATE_ERROR;
  const skipUpdate = process.env.CUBE_SKIP_UPDATE === "1";
  delete process.env.CUBE_UPDATE_ERROR;
  delete process.env.CUBE_SKIP_UPDATE;
  if (updateError) updateNotices.push({ level: "error", message: updateError });
  try {
    const update = skipUpdate ? null : await checkCubeUpdate();
    if (update) {
      const decision = await onboarding.pickUpdate(update);
      if (!decision) { onboarding.stopTerminal(); return; }
      if (decision === "update") {
        const prepared = await onboarding.downloadUpdate((signal) => prepareCubeUpdate(update, { signal }));
        if (prepared) onboarding.showNotice({ level: "info", message: "Update verified. Restarting Cube…" });
        onboarding.stopTerminal();
        process.exitCode = prepared ? 75 : 0;
        return;
      }
    }
  } catch (error) {
    updateNotices.push({ level: "error", message: `${error instanceof Error ? error.message : String(error)} Using the current Cube build.` });
    onboarding.stopTerminal();
  }
  const createScreen = (bootstrap: Awaited<ReturnType<typeof prepareCubeRuntime>>) => {
    const model = bootstrap.readiness.ready ? bootstrap.readiness.model : undefined;
    const screen = new ChatScreen({
      tui,
      basePath: bootstrap.workspaceRoot,
      petCacheDir: join(bootstrap.home.getRoot(), "cache", "tui-pet", "cube"),
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
    for (const notice of updateNotices) screen.showNotice(notice);
    return screen;
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
