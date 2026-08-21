import {
  ProcessTerminal,
  TUI,
  matchesKey,
} from "@earendil-works/pi-tui";
import { mountChatScreen } from "./screens/chat.screen.js";
import {
  ThreadPickerOverlay,
  type ThreadPickerViewItem,
} from "./components/thread-picker.js";
import {
  ModelPickerComponent,
  type ProviderGroup,
  type ModelItem,
  type ModelSelectionResult,
  type ReasoningEffort,
} from "./components/model-picker.js";
import type { ChatMessage, DisplayTool } from "./components/message-list.js";
import { renderUsageBoxToString, type UsageBoxContent } from "./components/usage-box.js";

export type { ChatMessage, DisplayTool } from "./components/message-list.js";
export type { ThreadPickerViewItem } from "./components/thread-picker.js";
export type {
  ProviderGroup,
  ModelItem,
  ModelSelectionResult,
  ReasoningEffort,
} from "./components/model-picker.js";
export { ThreadPickerOverlay } from "./components/thread-picker.js";
export { ModelPickerComponent } from "./components/model-picker.js";
export { SearchBar, type SearchBarOptions } from "./components/search-bar.js";
export { KeyHint, type KeyHintItem } from "./components/key-hint.js";
export { WorkingIndicator } from "./components/working-indicator.js";
export { UsageBox, renderUsageBoxToString, type UsageBoxContent } from "./components/usage-box.js";

export interface SlashCommandSuggestion {
  name: `/${string}`;
  description: string;
}

export interface SystemInfo {
  model?: string;
  workspace?: string;
  agentMd?: string;
  threadId?: string;
}

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
  isActive: boolean;
}

export interface UsageBoxMetrics {
  title?: string;
  model: string;
  reasoningEffort?: string;
  capabilities?: string[];
  contextLimit: number;
  maxOutput?: number;
  activeTurnTokens?: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  totalTokens: number;
  threadTitle?: string;
  threadId: string;
}

export type CubeAction =
  | { type: "prompt:submit"; content: string }
  | { type: "command:submit"; name: `/${string}`; argument?: string }
  | {
      type: "model:select";
      modelId: string;
      reasoningEffort?: ReasoningEffort;
    }
  | { type: "thread:select"; threadId: string }
  | { type: "turn:cancel" }
  | { type: "app:exit" };

export type CubeEvent =
  | { type: "state:info"; info: SystemInfo }
  | { type: "turn:start"; message?: string }
  | { type: "turn:delta"; text: string }
  | { type: "turn:tool"; tool: DisplayTool }
  | { type: "turn:end" }
  | { type: "message:add"; message: ChatMessage | string }
  | { type: "message:upsert"; message: ChatMessage }
  | { type: "messages:set"; messages: ChatMessage[] }
  | { type: "messages:clear" }
  | {
      type: "dialog:model_picker";
      providers: ProviderGroup[];
      currentModelId?: string;
      currentReasoningEffort?: ReasoningEffort;
    }
  | { type: "dialog:thread_picker"; threads: ThreadSummary[] }
  | { type: "usage:metrics"; metrics: UsageBoxMetrics }
  | { type: "system:message"; content: string }
  | { type: "system:error"; error: string };

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
  openThreadPicker: (
    options: OpenThreadPickerOptions,
  ) => Promise<string | null>;
  openModelPicker: (
    options: OpenModelPickerOptions,
  ) => Promise<ModelSelectionResult | null>;
}

export type TerminalCursorShape =
  | "blinking-block"
  | "block"
  | "blinking-underline"
  | "underline"
  | "blinking-bar"
  | "bar";

export const setTerminalCursorShape = (
  shape: TerminalCursorShape = "blinking-bar",
): void => {
  const codes: Record<TerminalCursorShape, string> = {
    "blinking-block": "\x1b[1 q",
    block: "\x1b[2 q",
    "blinking-underline": "\x1b[3 q",
    underline: "\x1b[4 q",
    "blinking-bar": "\x1b[5 q",
    bar: "\x1b[6 q",
  };
  try {
    process.stdout.write(codes[shape] || "\x1b[5 q");
  } catch {}
};

export const resetTerminalCursorShape = (): void => {
  try {
    process.stdout.write("\x1b[0 q");
  } catch {}
};

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
      setTerminalCursorShape("blinking-bar");
      tui.start();
    },
    stop: () => {
      resetTerminalCursorShape();
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
