import { ProcessTerminal, TuiMainScreen, type TUI } from "@earendil-works/pi-tui";
import {
  type CubeUIAction,
  type CubeUIEvent,
  type Session,
  type AgentControllerEvent,
  type AgentControllerDisplayState,
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
import { ThemePickerOverlay, type ThemePickerItem } from "./components/theme-picker.js";
import { TitlePickerComponent, formatTerminalTitle, type TitlePickerOptions } from "./components/title-picker.js";
import { StatusLinePickerComponent, type StatusLinePickerOptions } from "./components/statusline-picker.js";
import { ApprovalPicker, type ToolApprovalDecision } from "./components/approval-picker.js";
import { renderUsageBoxToString, type UsageBoxContent } from "./components/usage-box.js";
import { setSyntaxTheme as setTheme } from "./themes/syntax.theme.js";
import { matchesBinding } from "./keybindings.js";

export type {
  CubeUIAction,
  CubeUIEvent,
  Session,
  AgentControllerEvent,
  AgentControllerDisplayState,
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
export { ThemePickerOverlay, type ThemePickerItem } from "./components/theme-picker.js";
export {
  ApprovalPicker,
  type ApprovalPickerOptions,
  type ToolApprovalDecision,
} from "./components/approval-picker.js";
export { SearchBar, type SearchBarOptions } from "./components/search-bar.js";
export { KeyHint, type KeyHintItem } from "./components/key-hint.js";
export { WorkingIndicator } from "./components/working-indicator.js";
export { TitlePickerComponent, type TitlePickerOptions, type TitlePickerItem } from "./components/title-picker.js";
export { StatusLinePickerComponent, type StatusLinePickerOptions, type StatusLinePickerItem } from "./components/statusline-picker.js";

export interface OpenThreadPickerOptions {
  threads: ThreadPickerViewItem[];
}

export interface OpenModelPickerOptions {
  providers: ProviderGroup[];
  currentModelId?: string;
  currentReasoningEffort?: ReasoningEffort;
}

export interface OpenThemePickerOptions {
  currentThemeId?: string;
}

export interface OpenToolApprovalOptions {
  toolName: string;
  args: unknown;
}

export interface CreateAppOptions {
  session: Session;
  onAction: (action: CubeUIAction) => void;
  slashCommands?: SlashCommandSuggestion[];
  basePath?: string;
  tui?: TUI;
  initialHistory?: string[];
  appTitle?: string[];
  statusLine?: string[];
}

export interface TuiApp {
  start: () => void;
  stop: () => void;
  handleUIEvent: (event: CubeUIEvent) => void;
  handleSessionEvent: (event: AgentControllerEvent) => void;
  openThreadPicker: (options: OpenThreadPickerOptions) => Promise<string | null>;
  openModelPicker: (options: OpenModelPickerOptions) => Promise<ModelSelectionResult | null>;
  openThemePicker: (options?: OpenThemePickerOptions) => Promise<string | null>;
  openTitlePicker: () => Promise<string[] | null>;
  openStatusLinePicker: () => Promise<string[] | null>;
  openToolApproval: (options: OpenToolApprovalOptions) => Promise<ToolApprovalDecision>;
}

export const CubeApp = (options: CreateAppOptions): TuiApp => {
  const tui = options.tui ?? new TuiMainScreen(new ProcessTerminal());
  let unsubscribeSession: () => void = () => {};
  let activeApprovalId: string | null = null;
  let historyRevision = 0;
  let nativeQueuedFollowUps = options.session.displayState.get().queuedFollowUps ?? 0;
  let locallyCancelledQueueTransitions = 0;
  let latestInfo: SystemInfo = {};
  let currentTitleFields = options.appTitle ?? ["model", "workspace", "threadId"];

  const updateTerminalTitle = (fields: string[] = currentTitleFields) => {
    currentTitleFields = fields;
    const title = formatTerminalTitle(fields, {
      model: latestInfo.model,
      workspace: latestInfo.workspace,
      threadId: latestInfo.threadId,
      status: options.session.displayState.get().isRunning ? "Busy" : "Idle",
    });
    try {
      process.stdout.write(`\x1b]0;${title}\x07`);
      process.title = title;
    } catch {
      // ignore
    }
  };

  const screen = mountChatScreen(tui, {
    onAction: (action) => {
      if (action.type === "prompt:submit") {
        const state = options.session.displayState.get();
        if (state.isRunning || (state.queuedFollowUps ?? 0) > 0) {
          screen.promptEditor.enqueueQueuedPrompt(action.content);
        } else {
          screen.messageList.addMessage({
            role: "user",
            content: action.content,
            status: "done",
          });
        }
        tui.requestRender();
      }
      options.onAction(action);
    },
    slashCommands: options.slashCommands ?? [],
    basePath: options.basePath ?? process.cwd(),
    initialHistory: options.initialHistory,
    statusLine: options.statusLine,
  });

  const cancelNextQueuedPrompt = (): boolean => {
    const queuedPrompt = screen.promptEditor.dequeueQueuedPrompt();
    if (queuedPrompt === undefined) return false;

    const nativePrompt = options.session.followUps.dequeue();
    if (nativePrompt === undefined) {
      screen.promptEditor.prependQueuedPrompt(queuedPrompt);
      return true;
    }

    locallyCancelledQueueTransitions += 1;
    options.session.emit({
      type: "follow_up_queued",
      count: options.session.followUps.count(),
    });
    tui.requestRender();
    return true;
  };

  const handleInterrupt = (): { consume: true } | undefined => {
    if (cancelNextQueuedPrompt()) return { consume: true };

    const state = options.session.displayState.get();
    if (state.pendingApproval || state.pendingSuspensions.size > 0) {
      return undefined;
    }
    if (state.isRunning) {
      options.session.abort();
      return { consume: true };
    }
    return undefined;
  };

  tui.addInputListener((data: string) => {
    if (matchesBinding(data, "cube.transcript.toggle")) {
      screen.messageList.toggleToolOutput();
      tui.requestRender();
      return { consume: true };
    }
    if (matchesBinding(data, "cube.app.exit")) {
      const interruptResult = handleInterrupt();
      if (interruptResult) return interruptResult;

      const state = options.session.displayState.get();
      if (
        state.pendingApproval ||
        state.pendingSuspensions.size > 0 ||
        screen.workingIndicator.isActive()
      ) {
        return undefined;
      }
      options.onAction({ type: "app:exit" });
      return { consume: true };
    }
    if (matchesBinding(data, "cube.turn.interrupt")) {
      return handleInterrupt();
    }
    return undefined;
  });

  const app: TuiApp = {
    start: () => {
      updateTerminalTitle();
      tui.start();
    },
    stop: () => {
      unsubscribeSession();
      if (options.session.displayState.get().isRunning) {
        options.session.abort();
      }
      screen.workingIndicator.stop();
      tui.stop();
    },
    handleUIEvent: (event: CubeUIEvent) => {
      switch (event.type) {
        case "state:info":
          latestInfo = { ...latestInfo, ...event.info };
          screen.infoBox.setInfo(event.info);
          screen.footer.setInfo(event.info);
          updateTerminalTitle();
          tui.requestRender();
          break;
        case "activity:start":
          screen.workingIndicator.start(event.message);
          tui.requestRender();
          break;
        case "activity:end":
          screen.workingIndicator.stop();
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
        case "dialog:theme":
          void app
            .openThemePicker({
              currentThemeId: event.currentThemeId,
            })
            .then((themeId) => {
              if (themeId) {
                setTheme(themeId);
                tui.requestRender();
                options.onAction({
                  type: "theme:select",
                  themeId,
                });
              }
            });
          break;
        case "dialog:title_picker":
          void app.openTitlePicker().then((selectedIds) => {
            if (selectedIds && selectedIds.length > 0) {
              options.onAction({
                type: "title:select",
                appTitle: selectedIds,
              });
            }
          });
          break;
        case "dialog:statusline_picker":
          void app.openStatusLinePicker().then((selectedIds) => {
            if (selectedIds && selectedIds.length > 0) {
              options.onAction({
                type: "statusline:select",
                statusLine: selectedIds,
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
    handleSessionEvent: (event: AgentControllerEvent) => {
      switch (event.type) {
        case "display_state_changed": {
          const nextQueuedFollowUps = event.displayState.queuedFollowUps ?? 0;
          if (nextQueuedFollowUps < nativeQueuedFollowUps) {
            let removedCount = nativeQueuedFollowUps - nextQueuedFollowUps;
            const cancelledCount = Math.min(removedCount, locallyCancelledQueueTransitions);
            locallyCancelledQueueTransitions -= cancelledCount;
            removedCount -= cancelledCount;
            for (const content of screen.promptEditor.dequeueQueuedPrompts(removedCount)) {
              screen.messageList.addMessage({
                role: "user",
                content,
                status: "done",
              });
            }
          }
          nativeQueuedFollowUps = nextQueuedFollowUps;
          const tools = new Map<string, DisplayTool>();
          for (const [toolCallId, tool] of event.displayState.activeTools) {
            tools.set(toolCallId, {
              id: toolCallId,
              name: tool.name,
              args: tool.args,
              status: tool.status,
              partialResult: tool.partialResult,
              result: tool.result,
              shellOutput: tool.shellOutput,
            });
          }
          screen.messageList.applySessionDisplayState({
            currentMessage: event.displayState.currentMessage,
            isRunning: event.displayState.isRunning,
            activeTools: tools,
            pendingApproval: event.displayState.pendingApproval,
          });
          screen.workingIndicator.sync(event.displayState);
          tui.requestRender();
          break;
        }
        case "tool_approval_required":
          if (activeApprovalId === event.toolCallId) break;
          activeApprovalId = event.toolCallId;
          screen.workingIndicator.stop();
          void app
            .openToolApproval({
              toolName: event.toolName,
              args: event.args,
            })
            .then((decision) => {
              if (decision === "approve_prefix") {
                options.session.grantTool(event.toolName);
              }
              options.session.respondToToolApproval({
                toolCallId: event.toolCallId,
                decision: decision === "decline" ? "decline" : "approve",
                ...(decision === "decline"
                  ? { declineContext: { reason: "User declined tool execution." } }
                  : {}),
              });
            })
            .finally(() => {
              activeApprovalId = null;
            });
          break;
        case "thread_changed": {
          screen.promptEditor.clearQueuedPrompts();
          nativeQueuedFollowUps = 0;
          locallyCancelledQueueTransitions = 0;
          const revision = ++historyRevision;
          void options.session.thread
            .listMessages({ threadId: event.threadId })
            .then((messages) => {
              if (revision !== historyRevision || options.session.thread.getId() !== event.threadId)
                return;
              if (messages.length > 0 || screen.messageList.getMessages().length === 0) {
                screen.messageList.setSessionMessages(messages);
                tui.requestRender();
              }
            })
            .catch((error: unknown) => {
              screen.messageList.addMessage({
                role: "system",
                content: `Error loading thread: ${error instanceof Error ? error.message : String(error)}`,
                status: "error",
              });
              tui.requestRender();
            });
          break;
        }
        case "error":
          screen.workingIndicator.stop();
          screen.messageList.addMessage({
            role: "system",
            content: `Error: ${event.error.message}`,
            status: "error",
          });
          tui.requestRender();
          break;
        case "workspace_status_changed":
          if (String(event.status) !== "ready") {
            screen.workingIndicator.start(`Workspace: ${String(event.status)}`);
          }
          break;
        case "workspace_ready":
          screen.workingIndicator.stop();
          break;
        case "workspace_error":
          screen.workingIndicator.stop();
          screen.messageList.addMessage({
            role: "system",
            content: `Workspace error: ${event.error.message}`,
            status: "error",
          });
          tui.requestRender();
          break;
      }
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
    openThemePicker: (pickerOptions: OpenThemePickerOptions = {}) => {
      return new Promise<string | null>((resolve) => {
        let closed = false;
        const currentThemeId = pickerOptions.currentThemeId || "default";

        const finish = (result: string | null) => {
          if (closed) return;
          closed = true;
          if (result) {
            setTheme(result);
          } else {
            setTheme(currentThemeId);
          }
          tui.removeChild(screen.footer);
          tui.removeChild(picker);
          tui.addChild(screen.promptEditor);
          tui.addChild(screen.footer);
          tui.setFocus(screen.promptEditor);
          tui.requestRender();
          resolve(result);
        };

        const picker = new ThemePickerOverlay({
          currentThemeId,
          onSelect: (themeId) => finish(themeId),
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
    openTitlePicker: () => {
      return new Promise<string[] | null>((resolve) => {
        let closed = false;

        const finish = (selectedIds: string[] | null) => {
          if (closed) return;
          closed = true;
          tui.removeChild(screen.footer);
          tui.removeChild(picker);
          tui.addChild(screen.promptEditor);
          tui.addChild(screen.footer);
          tui.setFocus(screen.promptEditor);
          tui.requestRender();

          if (selectedIds && selectedIds.length > 0) {
            updateTerminalTitle(selectedIds);
            tui.requestRender();
          }

          resolve(selectedIds);
        };

        const picker = new TitlePickerComponent({
          initialSelection: currentTitleFields,
          currentValues: {
            model: latestInfo.model,
            threadId: latestInfo.threadId,
            workspace: latestInfo.workspace,
            status: options.session.displayState.get().isRunning ? "Busy" : "Idle",
          },
          onSelect: (ids) => finish(ids),
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
    openStatusLinePicker: () => {
      return new Promise<string[] | null>((resolve) => {
        let closed = false;

        const finish = (selectedIds: string[] | null) => {
          if (closed) return;
          closed = true;
          tui.removeChild(screen.footer);
          tui.removeChild(picker);
          tui.addChild(screen.promptEditor);
          tui.addChild(screen.footer);
          tui.setFocus(screen.promptEditor);
          tui.requestRender();

          if (selectedIds && selectedIds.length > 0) {
            screen.footer.setStatusLine(selectedIds);
            tui.requestRender();
          }

          resolve(selectedIds);
        };

        const picker = new StatusLinePickerComponent({
          initialSelection: screen.footer.getStatusLine(),
          currentValues: {
            model: latestInfo.model,
            workspace: latestInfo.workspace,
            agentMd: latestInfo.agentMd,
            threadId: latestInfo.threadId,
            status: options.session.displayState.get().isRunning ? "Busy" : "Idle",
          },
          onSelect: (ids: string[]) => finish(ids),
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
    openToolApproval: (pickerOptions: OpenToolApprovalOptions) => {
      return new Promise<ToolApprovalDecision>((resolve) => {
        let closed = false;

        const finish = (decision: ToolApprovalDecision) => {
          if (closed) return;
          closed = true;
          tui.removeChild(screen.footer);
          tui.removeChild(picker);
          tui.addChild(screen.promptEditor);
          tui.addChild(screen.footer);
          tui.setFocus(screen.promptEditor);
          tui.requestRender();
          resolve(decision);
        };

        const picker = new ApprovalPicker({
          toolName: pickerOptions.toolName,
          args: pickerOptions.args,
          onDecision: finish,
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

  unsubscribeSession = options.session.subscribe(app.handleSessionEvent);
  app.handleSessionEvent({
    type: "display_state_changed",
    displayState: options.session.displayState.get(),
  });

  return app;
};
