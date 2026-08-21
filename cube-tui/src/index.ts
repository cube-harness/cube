#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessTerminal, TUI, matchesKey } from "@earendil-works/pi-tui";
import {
  CubeRuntime,
  type CubeAction,
  type CubeEvent,
  type SystemInfo,
  type ThreadSummary,
  type UsageBoxMetrics,
  type SlashCommandSuggestion,
  type ChatMessage,
  type DisplayTool,
  type ProviderGroup,
  type ModelItem,
  type ModelSelectionResult,
  type ReasoningEffort,
} from "@cube/runtime";

import { mountChatScreen } from "./screens/chat.screen.js";
import { ThreadPickerOverlay, type ThreadPickerViewItem } from "./components/thread-picker.js";
import { ModelPickerComponent } from "./components/model-picker.js";
import { renderUsageBoxToString, type UsageBoxContent } from "./components/usage-box.js";

export type {
  CubeAction,
  CubeEvent,
  SystemInfo,
  ThreadSummary,
  UsageBoxMetrics,
  SlashCommandSuggestion,
  ChatMessage,
  DisplayTool,
  ProviderGroup,
  ModelItem,
  ModelSelectionResult,
  ReasoningEffort,
};

export type { ThreadPickerViewItem } from "./components/thread-picker.js";
export { ThreadPickerOverlay } from "./components/thread-picker.js";
export { ModelPickerComponent } from "./components/model-picker.js";
export { SearchBar, type SearchBarOptions } from "./components/search-bar.js";
export { KeyHint, type KeyHintItem } from "./components/key-hint.js";
export { WorkingIndicator } from "./components/working-indicator.js";
export { UsageBox, renderUsageBoxToString, type UsageBoxContent } from "./components/usage-box.js";

export type TuiAction = CubeAction;

export interface OpenThreadPickerOptions {
  threads: ThreadPickerViewItem[];
}

export interface OpenModelPickerOptions {
  providers: ProviderGroup[];
  currentModelId?: string;
  currentReasoningEffort?: ReasoningEffort;
}

export interface CreateAppOptions {
  onAction: (action: CubeAction) => void;
  slashCommands?: SlashCommandSuggestion[];
  basePath?: string;
}

export interface TuiApp {
  start: () => void;
  stop: () => void;
  handleEvent: (event: CubeEvent) => void;
  addMessage: (msg: ChatMessage | string) => void;
  upsertMessage: (msg: ChatMessage) => void;
  upsertTool: (tool: DisplayTool) => void;
  setMessages: (messages: ChatMessage[]) => void;
  clearMessages: () => void;
  startLoading: (message?: string) => void;
  updateLoading: (message: string) => void;
  stopLoading: () => void;
  setInfo: (info: SystemInfo) => void;
  openThreadPicker: (options: OpenThreadPickerOptions) => Promise<string | null>;
  openModelPicker: (options: OpenModelPickerOptions) => Promise<ModelSelectionResult | null>;
}

export const CubeApp = (options: CreateAppOptions): TuiApp => {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  tui.setShowHardwareCursor(true);

  const screen = mountChatScreen(tui, {
    onAction: (action) => {
      options.onAction(action);
    },
    slashCommands: options.slashCommands ?? [],
    basePath: options.basePath ?? process.cwd(),
  });

  tui.addInputListener((data: string) => {
    if (matchesKey(data, "ctrl+c")) {
      options.onAction({ type: "turn:cancel" });
      return { consume: true };
    }
    return undefined;
  });

  const app: TuiApp = {
    start: () => {
      tui.start();
    },
    stop: () => {
      tui.stop();
    },
    handleEvent: (event: CubeEvent) => {
      switch (event.type) {
        case "state:info":
          screen.infoBox.setInfo(event.info);
          screen.footer.setInfo(event.info);
          tui.requestRender();
          break;
        case "turn:start":
          screen.workingIndicator.start(event.message);
          tui.requestRender();
          break;
        case "turn:delta":
          screen.workingIndicator.stop();
          screen.messageList.upsertMessage({
            role: "assistant",
            content: event.text,
            status: "streaming",
          });
          tui.requestRender();
          break;
        case "turn:tool":
          screen.messageList.upsertTool(event.tool);
          tui.requestRender();
          break;
        case "turn:end":
          screen.workingIndicator.stop();
          tui.requestRender();
          break;
        case "message:add":
          screen.messageList.addMessage(event.message);
          tui.requestRender();
          break;
        case "message:upsert":
          screen.messageList.upsertMessage(event.message);
          tui.requestRender();
          break;
        case "messages:set":
          screen.messageList.setMessages(event.messages);
          tui.requestRender();
          break;
        case "messages:clear":
          screen.messageList.clearMessages();
          tui.requestRender();
          break;
        case "dialog:model_picker":
          void app
            .openModelPicker({
              providers: event.providers,
              currentModelId: event.currentModelId,
              currentReasoningEffort: event.currentReasoningEffort,
            })
            .then((result) => {
              if (result) {
                options.onAction({
                  type: "model:select",
                  modelId: result.modelId,
                  reasoningEffort: result.reasoningEffort,
                });
              }
            });
          break;
        case "dialog:thread_picker":
          void app
            .openThreadPicker({
              threads: event.threads,
            })
            .then((threadId) => {
              if (threadId) {
                options.onAction({
                  type: "thread:select",
                  threadId,
                });
              }
            });
          break;
        case "usage:metrics":
          screen.messageList.addMessage(renderUsageBoxToString(event.metrics));
          tui.requestRender();
          break;
        case "system:message":
          screen.messageList.addMessage({
            role: "system",
            content: event.content,
          });
          tui.requestRender();
          break;
        case "system:error":
          screen.messageList.addMessage({
            role: "system",
            content: `Error: ${event.error}`,
          });
          tui.requestRender();
          break;
      }
    },
    addMessage: (msg: ChatMessage | string) => {
      screen.messageList.addMessage(msg);
      tui.requestRender();
    },
    upsertMessage: (msg: ChatMessage) => {
      screen.messageList.upsertMessage(msg);
      tui.requestRender();
    },
    upsertTool: (tool: DisplayTool) => {
      screen.messageList.upsertTool(tool);
      tui.requestRender();
    },
    setMessages: (messages: ChatMessage[]) => {
      screen.messageList.setMessages(messages);
      tui.requestRender();
    },
    clearMessages: () => {
      screen.messageList.clearMessages();
      tui.requestRender();
    },
    startLoading: (message?: string) => {
      screen.workingIndicator.start(message);
    },
    updateLoading: (message: string) => {
      screen.workingIndicator.setMessage(message);
    },
    stopLoading: () => {
      screen.workingIndicator.stop();
    },
    setInfo: (info) => {
      screen.infoBox.setInfo(info);
      screen.footer.setInfo(info);
      tui.requestRender();
    },
    openThreadPicker: (pickerOptions: OpenThreadPickerOptions) => {
      return new Promise<string | null>((resolve) => {
        let closed = false;

        const finish = (result: string | null) => {
          if (closed) return;
          closed = true;
          tui.removeChild(screen.footer);
          tui.removeChild(picker);
          tui.addChild(screen.promptEditor);
          tui.addChild(screen.footer);
          tui.setFocus(screen.promptEditor);
          tui.requestRender();
          resolve(result);
        };

        const picker = new ThreadPickerOverlay({
          threads: pickerOptions.threads,
          onSelect: (threadId: string) => finish(threadId),
          onCancel: () => finish(null),
        });

        tui.removeChild(screen.footer);
        tui.removeChild(screen.promptEditor);
        tui.addChild(picker);
        tui.addChild(screen.footer);
        tui.setFocus(picker);
        tui.requestRender();
      });
    },
    openModelPicker: (pickerOptions: OpenModelPickerOptions) => {
      return new Promise<ModelSelectionResult | null>((resolve) => {
        let closed = false;

        const finish = (result: ModelSelectionResult | null) => {
          if (closed) return;
          closed = true;
          tui.removeChild(screen.footer);
          tui.removeChild(picker);
          tui.addChild(screen.promptEditor);
          tui.addChild(screen.footer);
          tui.setFocus(screen.promptEditor);
          tui.requestRender();
          resolve(result);
        };

        const picker = new ModelPickerComponent({
          providers: pickerOptions.providers,
          currentModelId: pickerOptions.currentModelId,
          currentReasoningEffort: pickerOptions.currentReasoningEffort,
          onSelect: (result) => finish(result),
          onCancel: () => finish(null),
        });

        tui.removeChild(screen.footer);
        tui.removeChild(screen.promptEditor);
        tui.addChild(picker);
        tui.addChild(screen.footer);
        tui.setFocus(picker);
        tui.requestRender();
      });
    },
  };

  return app;
};

export const startTui = async (): Promise<void> => {
  const runtime = new CubeRuntime({
    onExit: () => {
      process.exit(0);
    },
  });

  await runtime.start();

  const app = CubeApp({
    onAction: (action) => {
      void runtime.dispatch(action);
    },
    slashCommands: runtime.suggestions,
    basePath: process.cwd(),
  });

  runtime.subscribe((event) => {
    app.handleEvent(event);
  });

  app.start();
  runtime.emitInitialState();
};

const isMainModule = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    const scriptPath = fs.realpathSync(process.argv[1]);
    const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32"
      ? scriptPath.toLowerCase() === modulePath.toLowerCase()
      : scriptPath === modulePath;
  } catch {
    const scriptResolved = path.resolve(process.argv[1]);
    const moduleResolved = fileURLToPath(import.meta.url);
    return process.platform === "win32"
      ? scriptResolved.toLowerCase() === moduleResolved.toLowerCase()
      : scriptResolved === moduleResolved;
  }
};

if (isMainModule()) {
  startTui().catch((err: unknown) => {
    console.error("Fatal TUI Error:", err);
    process.exit(1);
  });
}
