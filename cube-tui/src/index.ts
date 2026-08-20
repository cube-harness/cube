import { ProcessTerminal, TUI, matchesKey } from "@earendil-works/pi-tui";
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
export { WorkingIndicator } from "./components/working-indicator.js";
export { UsageBox, renderUsageBoxToString, type UsageBoxContent } from "./components/usage-box.js";

export interface SlashCommandSuggestion {
  name: `/${string}`;
  description: string;
}

export type TuiAction =
  | { type: "prompt_submit"; content: string }
  | {
      type: "command_submit";
      name: `/${string}`;
      argument: string;
    }
  | { type: "cancel" };

export interface OpenThreadPickerOptions {
  threads: ThreadPickerViewItem[];
}

export interface OpenModelPickerOptions {
  providers: ProviderGroup[];
  currentModelId?: string;
  currentReasoningEffort?: ReasoningEffort;
}

export interface CreateAppOptions {
  onAction: (action: TuiAction) => void;
  slashCommands?: SlashCommandSuggestion[];
  basePath?: string;
}

export interface TuiApp {
  start: () => void;
  stop: () => void;
  addMessage: (msg: ChatMessage | string) => void;
  upsertMessage: (msg: ChatMessage) => void;
  upsertTool: (tool: DisplayTool) => void;
  setMessages: (messages: ChatMessage[]) => void;
  clearMessages: () => void;
  startLoading: (message?: string) => void;
  updateLoading: (message: string) => void;
  stopLoading: () => void;
  setInfo: (info: {
    model?: string;
    workspace?: string;
    agentMd?: string;
    threadId?: string;
  }) => void;
  openThreadPicker: (
    options: OpenThreadPickerOptions,
  ) => Promise<string | null>;
  openModelPicker: (
    options: OpenModelPickerOptions,
  ) => Promise<ModelSelectionResult | null>;
}

export const CubeApp = (options: CreateAppOptions): TuiApp => {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const screen = mountChatScreen(tui, {
    onAction: options.onAction,
    slashCommands: options.slashCommands ?? [],
    basePath: options.basePath ?? process.cwd(),
  });

  tui.addInputListener((data: string) => {
    if (matchesKey(data, "ctrl+c")) {
      options.onAction({ type: "cancel" });
      return { consume: true };
    }
    return undefined;
  });

  return {
    start: () => {
      tui.start();
    },
    stop: () => {
      tui.stop();
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
          onSelect: (result: ModelSelectionResult) => finish(result),
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
};
