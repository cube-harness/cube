import {
  CancellableLoader,
  ProcessTerminal,
  TUI,
  type Terminal,
} from "@earendil-works/pi-tui";
import { ApprovalPicker } from "./components/approval-picker.js";
import type { InfoBoxContent } from "./components/info-box.js";
import type {
  ChatMessage,
  DisplayTool,
} from "./components/message-list.js";
import { ModelPicker } from "./components/model-picker.js";
import type { ModelCatalogItemView } from "./components/model-picker.js";
import { ModelConfigPicker } from "./components/model-config-picker.js";
import { mountChatScreen } from "./screens/chat.screen.js";
import { getTheme } from "./themes/color.schema.js";

export * from "./themes/color.schema.js";
export * from "./components/banner.js";
export * from "./components/approval-picker.js";
export * from "./components/header.js";
export * from "./components/info-box.js";
export * from "./components/message-list.js";
export * from "./components/footer.js";
export * from "./components/model-picker.js";
export * from "./components/model-config-picker.js";
export * from "./components/prompt-editor.js";
export * from "./components/working-indicator.js";
export * from "./screens/chat.screen.js";
export * from "./themes/pi-tui.theme.js";

export type TuiAction =
  | { type: "prompt_submit"; content: string }
  | { type: "command_submit"; name: `/${string}`; argument: string }
  | { type: "cancel" };

export interface SlashCommandSuggestion {
  name: `/${string}`;
  description: string;
}

export interface CreateAppOptions {
  onAction: (action: TuiAction) => void;
  slashCommands: SlashCommandSuggestion[];
  basePath: string;
  terminal?: Terminal;
}

export interface ModelCatalogView {
  models: ModelCatalogItemView[];
  warnings: string[];
}

export interface TuiModelSelection {
  modelId: string;
  config: { reasoning_effort?: string };
}

export interface OpenModelPickerOptions {
  currentSelection: TuiModelSelection;
  requestedModelId?: string;
  loadModels: (signal: AbortSignal) => Promise<ModelCatalogView>;
}

export interface ToolApprovalOptions {
  toolName: string;
  args: unknown;
}

export type AgentDisplayItem =
  | {
      type: "assistant";
      id: string;
      content: string;
      status: "streaming" | "done";
    }
  | {
      type: "tool";
      tool: DisplayTool;
    };

export interface AgentDisplaySnapshot {
  isRunning: boolean;
  approvalPending: boolean;
  currentMessage?: {
    id: string;
    content: string;
    status: "streaming" | "done";
  } | null;
  activeTools?: DisplayTool[];
  items?: AgentDisplayItem[];
}

const BLINKING_BAR_CURSOR = "\x1b[5 q";
const DEFAULT_CURSOR = "\x1b[0 q";

export const createApp = (options: CreateAppOptions) => {
  const tui = new TUI(options.terminal ?? new ProcessTerminal());
  const {
    banner,
    infoBox,
    messageList,
    footer,
    promptEditor,
    workingIndicator,
    inlineControlHost,
  } = mountChatScreen(tui, options);

  let activeModelPicker: ModelPicker | undefined;
  let activeModelConfigPicker: ModelConfigPicker | undefined;
  let activeLoadingOverlay: CancellableLoader | undefined;
  let activeApprovalPicker: ApprovalPicker | undefined;

  const openModelPicker = async (
    pickerOptions: OpenModelPickerOptions,
  ): Promise<TuiModelSelection | null> => {
    const theme = getTheme();
    const loader = new CancellableLoader(
      tui,
      theme.primary,
      theme.muted,
      "Loading models...",
    );
    activeLoadingOverlay = loader;
    inlineControlHost.addChild(loader);
    tui.setFocus(loader);
    tui.requestRender();
    loader.start();

    let loadingClosed = false;
    const closeLoading = () => {
      if (loadingClosed) return;
      loadingClosed = true;
      loader.dispose();
      inlineControlHost.removeChild(loader);
      if (activeLoadingOverlay === loader) activeLoadingOverlay = undefined;
      tui.requestRender();
    };

    const cancelled = Symbol("model-picker-cancelled");
    const cancellation = new Promise<typeof cancelled>((resolve) => {
      loader.onAbort = () => resolve(cancelled);
    });
    const catalogResult = Promise.resolve()
      .then(() => pickerOptions.loadModels(loader.signal))
      .then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
    const outcome = await Promise.race([catalogResult, cancellation]);
    closeLoading();

    if (outcome === cancelled) {
      tui.setFocus(promptEditor);
      return null;
    }
    if (outcome.status === "rejected") {
      tui.setFocus(promptEditor);
      throw outcome.error;
    }
    if (outcome.value.models.length === 0) {
      tui.setFocus(promptEditor);
      throw new Error("No models are currently available.");
    }
    const items = outcome.value.models;
    const warning = outcome.value.warnings.join(" • ") || undefined;
    const requestedItem = pickerOptions.requestedModelId
      ? items.find(({ id }) => id === pickerOptions.requestedModelId)
      : undefined;
    if (pickerOptions.requestedModelId && !requestedItem) {
      tui.setFocus(promptEditor);
      throw new Error(
        `Model ${pickerOptions.requestedModelId} is unavailable; check provider authentication and local model availability.`,
      );
    }
    if (requestedItem && !requestedItem.reasoningEfforts?.length) {
      tui.setFocus(promptEditor);
      return { modelId: requestedItem.id, config: {} };
    }

    return new Promise<TuiModelSelection | null>((resolve) => {
      let closed = false;
      let picker: ModelPicker | undefined;
      let configPicker: ModelConfigPicker | undefined;

      const finish = (selection: TuiModelSelection | null): void => {
        if (closed) return;
        closed = true;
        if (picker && activeModelPicker === picker) {
          inlineControlHost.removeChild(picker);
          activeModelPicker = undefined;
        }
        if (configPicker && activeModelConfigPicker === configPicker) {
          inlineControlHost.removeChild(configPicker);
          activeModelConfigPicker = undefined;
        }
        promptEditor.setVisible(true);
        tui.setFocus(promptEditor);
        tui.requestRender();
        resolve(selection);
      };

      const mountModelPicker = (): void => {
        if (!picker) return;
        activeModelPicker = picker;
        promptEditor.setVisible(false);
        inlineControlHost.addChild(picker);
        tui.setFocus(picker);
        tui.requestRender();
      };

      const mountConfigPicker = (
        item: ModelCatalogItemView,
        canGoBack: boolean,
      ): void => {
        if (picker && activeModelPicker === picker) {
          inlineControlHost.removeChild(picker);
          activeModelPicker = undefined;
        }
        const efforts = item.reasoningEfforts ?? [];
        configPicker = new ModelConfigPicker({
          modelId: item.id,
          efforts,
          ...(pickerOptions.currentSelection.modelId === item.id
            && pickerOptions.currentSelection.config.reasoning_effort
            && efforts.includes(pickerOptions.currentSelection.config.reasoning_effort)
            ? { currentEffort: pickerOptions.currentSelection.config.reasoning_effort }
            : {}),
          ...(warning ? { warning } : {}),
        });
        const mountedConfigPicker = configPicker;
        activeModelConfigPicker = mountedConfigPicker;
        promptEditor.setVisible(false);
        inlineControlHost.addChild(mountedConfigPicker);
        tui.setFocus(mountedConfigPicker);
        tui.requestRender();

        mountedConfigPicker.onSelect = (effort) => finish({
          modelId: item.id,
          config: { reasoning_effort: effort },
        });
        mountedConfigPicker.onBack = () => {
          if (activeModelConfigPicker === mountedConfigPicker) {
            inlineControlHost.removeChild(mountedConfigPicker);
            activeModelConfigPicker = undefined;
          }
          configPicker = undefined;
          if (canGoBack) mountModelPicker();
          else finish(null);
        };
      };

      if (requestedItem) {
        mountConfigPicker(requestedItem, false);
        return;
      }

      picker = new ModelPicker({
        models: items,
        currentModel: pickerOptions.currentSelection.modelId,
        ...(warning ? { warning } : {}),
      });
      picker.onSelect = (modelId) => {
        picker?.setError(undefined);
        const item = items.find(({ id }) => id === modelId);
        if (!item) {
          picker?.setError(`Model ${modelId} is no longer available.`);
          tui.requestRender();
          return;
        }
        if (!item.reasoningEfforts?.length) {
          finish({ modelId: item.id, config: {} });
          return;
        }
        mountConfigPicker(item, true);
      };
      picker.onCancel = () => finish(null);
      mountModelPicker();
    });
  };

  const requestToolApproval = (
    approvalOptions: ToolApprovalOptions,
  ): Promise<boolean> => {
    if (activeApprovalPicker) {
      return Promise.reject(new Error("Another tool approval is already pending."));
    }

    return new Promise<boolean>((resolve) => {
      const picker = new ApprovalPicker(approvalOptions);
      activeApprovalPicker = picker;
      promptEditor.setVisible(false);
      inlineControlHost.addChild(picker);
      tui.setFocus(picker);
      tui.requestRender();

      let closed = false;
      const closePicker = (approved: boolean) => {
        if (closed) return;
        closed = true;
        inlineControlHost.removeChild(picker);
        if (activeApprovalPicker === picker) activeApprovalPicker = undefined;
        promptEditor.setVisible(true);
        tui.setFocus(promptEditor);
        tui.requestRender();
        resolve(approved);
      };

      picker.onDecision = closePicker;
    });
  };

  const setWorking = (working: boolean) => {
    if (working) workingIndicator.start();
    else workingIndicator.stop();
  };

  return {
    tui,
    banner,
    infoBox,
    messageList,
    footer,
    promptEditor,
    workingIndicator,
    inlineControlHost,
    setWorking,
    addMessage: (message: ChatMessage | string) => {
      messageList.addMessage(message);
      tui.requestRender();
    },
    setInfo: (info: InfoBoxContent) => {
      infoBox.setInfo(info);
      footer.setInfo(info);
      tui.requestRender();
    },
    setModel: (model: string) => {
      infoBox.setInfo({ model });
      footer.setInfo({ model });
      tui.requestRender();
    },
    setWorkspace: (workspace: string) => {
      infoBox.setInfo({ workspace });
      footer.setInfo({ workspace });
      tui.requestRender();
    },
    renderAgentDisplay: (snapshot: AgentDisplaySnapshot) => {
      setWorking(snapshot.isRunning && !snapshot.approvalPending);
      if (snapshot.items && snapshot.items.length > 0) {
        for (const item of snapshot.items) {
          if (item.type === "assistant") {
            messageList.upsertMessage({
              id: item.id,
              role: "assistant",
              content: item.content,
              status: item.status,
            });
          } else if (item.type === "tool") {
            messageList.upsertTool(item.tool);
          }
        }
      } else {
        if (snapshot.currentMessage) {
          messageList.upsertMessage({
            ...snapshot.currentMessage,
            role: "assistant",
          });
        }
        for (const tool of snapshot.activeTools ?? []) messageList.upsertTool(tool);
      }
      tui.requestRender();
    },
    get modelPicker(): ModelPicker | undefined {
      return activeModelPicker;
    },
    get modelConfigPicker(): ModelConfigPicker | undefined {
      return activeModelConfigPicker;
    },
    get loadingOverlay(): CancellableLoader | undefined {
      return activeLoadingOverlay;
    },
    get approvalPicker(): ApprovalPicker | undefined {
      return activeApprovalPicker;
    },
    openModelPicker,
    requestToolApproval,
    start: () => {
      tui.setShowHardwareCursor(true);
      tui.terminal.write(BLINKING_BAR_CURSOR);
      tui.start();
    },
    stop: () => {
      tui.terminal.write(DEFAULT_CURSOR);
      tui.stop();
    },
  };
};
