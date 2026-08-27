#!/usr/bin/env node
import { CubeRuntime } from "@cube/runtime";
import { CubeApp, type TuiApp } from "./app.js";
import { setTheme } from "./themes/color.schema.js";

export const startTui = async (): Promise<void> => {
  let app: TuiApp;

  const runtime = new CubeRuntime({
    onExit: () => {
      app?.stop();
      process.exit(0);
    },
  });

  await runtime.start();
  setTheme(runtime.theme);
  const initialHistory = await runtime.getHistory();

  app = CubeApp({
    session: runtime.session,
    onAction: (action) => {
      void runtime.dispatch(action);
    },
    slashCommands: runtime.suggestions,
    basePath: process.cwd(),
    initialHistory,
    appTitle: runtime.appTitle,
    statusLine: runtime.statusLine,
  });

  runtime.subscribe((event) => {
    app.handleUIEvent(event);
  });

  process.once("SIGTERM", () => {
    void runtime.dispatch({ type: "app:exit" });
  });

  process.once("SIGINT", () => {
    void runtime.dispatch({ type: "app:exit" });
  });

  app.start();
  runtime.emitInitialState();
};

startTui().catch((error: unknown) => {
  console.error("Fatal TUI Error:", error);
  process.exit(1);
});
