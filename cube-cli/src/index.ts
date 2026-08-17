#!/usr/bin/env node

import { createCubeRuntime, type CubeRuntime } from "@cube/agent";
import { createApp, type TuiAction } from "@cube/tui";
import { createCubeWorkspace } from "@cube/workspace";
import { loadCubeEnv } from "./env.js";
import { createCliLifecycle } from "./lifecycle.js";
import { subscribeToSession } from "./session-events.js";
import { createSlashCommandRegistry } from "./slash-commands/registry.js";

export const runCli = async (): Promise<void> => {
  loadCubeEnv();
  const workspace = createCubeWorkspace();
  workspace.initialize();
  const configResult = workspace.config.read();
  if (!configResult.ok) {
    throw new Error(configResult.error);
  }
  let config = configResult.value;
  const targetDir = process.env.INIT_CWD || process.cwd();
  const identity = workspace.identity.resolve(targetDir);

  let runtime: CubeRuntime | undefined;
  let app: ReturnType<typeof createApp> | undefined;

  try {
    runtime = await createCubeRuntime({
      config,
      identity,
      runtimeFiles: workspace.agentRuntime,
      loadSystemPrompt: workspace.soul.snapshot,
    });

    const activeRuntime = runtime;
    const showSystemMessage = (content: string): void => {
      app?.addMessage({ role: "system", content });
    };
    const lifecycle = createCliLifecycle({
      isRunning: () => activeRuntime.session.run.isRunning(),
      abort: () => activeRuntime.session.abort(),
      stopTui: () => app?.stop(),
      closeRuntime: () => activeRuntime.close(),
    });
    const exitProcess = async (): Promise<void> => {
      await lifecycle.shutdown();
      process.exit(0);
    };
    const commandRegistry = createSlashCommandRegistry({
      model: {
        getCurrentSelection: activeRuntime.getModelSelection,
        getPersistedSelection: () => ({
          modelId: config.model,
          config: config.model_config,
        }),
        loadCatalog: activeRuntime.listAvailableModels,
        openModelPicker: (options) => {
          if (!app) throw new Error("Cube TUI is not ready.");
          return app.openModelPicker(options);
        },
        prepareSelection: activeRuntime.prepareModelSelection,
        applySelection: activeRuntime.applyModelSelection,
        persistSelection: (selection) => {
          const writeResult = workspace.config.write({
            ...config,
            model: selection.modelId,
            model_config: selection.config,
          });
          if (!writeResult.ok) {
            throw new Error(writeResult.error);
          }
          config = writeResult.value;
        },
        showMessage: showSystemMessage,
      },
      exit: { shutdown: exitProcess },
      compact: {
        getThreadId: () => activeRuntime.session.thread.getId(),
        isTurnActive: () => activeRuntime.session.run.isRunning(),
        finalizeMemory: activeRuntime.finalizeThreadMemory,
        showMessage: showSystemMessage,
      },
      showMessage: showSystemMessage,
    });

    const handleTuiAction = async (action: TuiAction): Promise<void> => {
      switch (action.type) {
        case "prompt_submit": {
          const preparation = await activeRuntime.preparePrompt();
          if (!preparation.ok) {
            showSystemMessage(preparation.error);
            return;
          }
          if (preparation.warning) {
            showSystemMessage(preparation.warning);
          }
          app?.addMessage({ role: "user", content: action.content });
          await activeRuntime.followUp(action.content);
          return;
        }
        case "command_submit":
          await commandRegistry.execute(action.name, action.argument);
          return;
        case "cancel":
          await lifecycle.cancel();
          return;
      }
    };

    app = createApp({
      onAction: (action) => {
        void handleTuiAction(action).catch((error: unknown) => {
          showSystemMessage(error instanceof Error ? error.message : String(error));
        });
      },
      slashCommands: commandRegistry.suggestions,
      basePath: identity.canonicalPath,
    });
    if (configResult.warning) {
      showSystemMessage(configResult.warning);
    }
    for (const warning of activeRuntime.warnings) showSystemMessage(warning);

    subscribeToSession({
      session: activeRuntime.session,
      app,
      showSystemMessage,
    });
    app.setInfo({
      model: activeRuntime.getModelSelection().modelId,
      workspace: identity.canonicalPath,
      agentMd: "SOUL.md (active)",
      threadId: activeRuntime.session.thread.getId() ?? "new thread",
    });

    process.once("SIGTERM", () => {
      void exitProcess();
    });
    app.start();
  } catch (error) {
    app?.stop();
    await runtime?.close().catch(() => undefined);
    throw error;
  }
};

await runCli().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
