import crypto from "node:crypto";
import { cubeController, cubeAgent, home } from "@cube/agent";
import { ConfigStore, Workspace, createBootstrap } from "@cube/workspace";
import { CommandManager } from "./command-manager.js";
import { ActionDispatcher } from "./dispatcher.js";
import type {
  CubeAction,
  CubeEventListener,
  SlashCommandSuggestion,
} from "./contracts/events.contract.js";

import { createResumeCommandHandler } from "./commands/resume.command.js";
import { createNewCommandHandler } from "./commands/new.command.js";
import { createExitCommandHandler } from "./commands/exit.command.js";
import { createCompactCommandHandler } from "./commands/compact.command.js";
import { createModelCommandHandler } from "./commands/model.command.js";
import { createHelpCommandHandler } from "./commands/help.command.js";
import { createRenameCommandHandler } from "./commands/rename.command.js";
import { createDeleteCommandHandler } from "./commands/delete.command.js";
import { createForkCommandHandler } from "./commands/fork.command.js";
import { createUsageCommandHandler } from "./commands/usage.command.js";

import { createPromptHandler } from "./handlers/prompt.handler.js";
import { createCommandHandler } from "./handlers/command.handler.js";
import { createCancelHandler } from "./handlers/cancel.handler.js";
import { createModelSelectHandler } from "./handlers/model-select.handler.js";
import { createThreadSelectHandler } from "./handlers/thread-select.handler.js";

export interface CubeRuntimeOptions {
  workspacePath?: string;
  onExit?: () => void;
}

const extractMessageText = (raw: any): string => {
  if (typeof raw === "string") return raw;
  if (!raw) return "";
  if (typeof raw.text === "string") return raw.text;
  if (typeof raw.content === "string") return raw.content;

  const parts = Array.isArray(raw.parts)
    ? raw.parts
    : raw.content && Array.isArray(raw.content.parts)
      ? raw.content.parts
      : [];

  if (parts.length > 0) {
    return parts
      .map((p: any) => {
        if (typeof p === "string") return p;
        if (p.type === "text" && typeof p.text === "string") return p.text;
        if (typeof p.text === "string") return p.text;
        if (p.data && typeof p.data.contents === "string") return p.data.contents;
        if (p.data && typeof p.data.text === "string") return p.data.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
};

export class CubeRuntime {
  public readonly dispatcher = new ActionDispatcher();
  public readonly commandManager: CommandManager;
  private readonly workspacePath: string;
  private plannedThreadId: `${string}-${string}-${string}-${string}-${string}`;
  private session?: any;
  private config?: any;
  private workspacePaths?: any;
  private readonly onExit?: () => void;

  constructor(options: CubeRuntimeOptions = {}) {
    this.workspacePath = options.workspacePath || process.env.INIT_CWD || process.cwd();
    this.plannedThreadId = crypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`;
    this.onExit = options.onExit;

    this.commandManager = new CommandManager((message) => {
      this.dispatcher.emit({ type: "system:message", content: message });
    });
  }

  get suggestions(): SlashCommandSuggestion[] {
    return this.commandManager.suggestions;
  }

  subscribe(listener: CubeEventListener): () => void {
    return this.dispatcher.subscribe(listener);
  }

  async dispatch(action: CubeAction): Promise<void> {
    await this.dispatcher.dispatch(action);
  }

  async start(): Promise<void> {
    await home.ensure();
    await createBootstrap(home).run();

    const workspace = Workspace(home, this.workspacePath);
    this.workspacePaths = await workspace.getPaths();
    this.config = await ConfigStore(home).read();

    this.session = await cubeController.createSession({
      resourceId: this.workspacePaths.root,
    });

    // Startup Normalization
    const boundId = this.session.thread.getId();
    if (boundId) {
      const activeMessages = await this.session.thread.listActiveMessages({ limit: 1 });
      if (activeMessages.length > 0) {
        this.session.thread.detachFromCurrent();
        await this.session.thread.clearAndReleaseLock();
      } else {
        await this.session.thread.delete({ threadId: boundId });
      }
    }

    const exitProcess = async (): Promise<void> => {
      if (this.session && this.session.thread.getId() !== null) {
        await this.session.thread.clearAndReleaseLock().catch(() => undefined);
      }
      this.onExit?.();
    };

    // Register all commands
    this.commandManager.registerMany([
      {
        name: "/resume",
        description: "Switch to a previous conversation thread",
        handler: createResumeCommandHandler({
          session: this.session,
          dispatcher: this.dispatcher,
        }),
      },
      {
        name: "/threads",
        description: "Alias for /resume",
        handler: createResumeCommandHandler({
          session: this.session,
          dispatcher: this.dispatcher,
        }),
      },
      {
        name: "/new",
        description: "Start a new conversation thread",
        handler: createNewCommandHandler({
          session: this.session,
          dispatcher: this.dispatcher,
          onNewThread: () => {
            this.plannedThreadId = crypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`;
          },
        }),
      },
      {
        name: "/exit",
        description: "Exit Cube",
        handler: createExitCommandHandler({ shutdown: exitProcess }),
      },
      {
        name: "/compact",
        description: "Finalize pending observational memory",
        handler: createCompactCommandHandler({
          getThreadId: () => this.session.thread.getId(),
          isTurnActive: () => this.session.run.isRunning(),
          showMessage: (msg) => this.dispatcher.emit({ type: "system:message", content: msg }),
        }),
      },
      {
        name: "/model",
        description: "View and select models",
        handler: createModelCommandHandler({
          home,
          dispatcher: this.dispatcher,
          isTurnActive: () => this.session.run.isRunning(),
        }),
      },
      {
        name: "/help",
        description: "Show available commands",
        handler: createHelpCommandHandler({
          commandManager: this.commandManager,
          showMessage: (msg) => this.dispatcher.emit({ type: "system:message", content: msg }),
        }),
      },
      {
        name: "/rename",
        description: "Rename current thread (/rename <title>)",
        handler: createRenameCommandHandler({
          session: this.session,
          dispatcher: this.dispatcher,
          isTurnActive: () => this.session.run.isRunning(),
        }),
      },
      {
        name: "/delete",
        description: "Delete a conversation thread",
        handler: createDeleteCommandHandler({
          session: this.session,
          dispatcher: this.dispatcher,
          isTurnActive: () => this.session.run.isRunning(),
        }),
      },
      {
        name: "/fork",
        description: "Clone current thread into a new branch",
        handler: createForkCommandHandler({
          session: this.session,
          dispatcher: this.dispatcher,
          isTurnActive: () => this.session.run.isRunning(),
        }),
      },
      {
        name: "/usage",
        description: "Show token usage & context window metrics",
        handler: createUsageCommandHandler({
          home,
          session: this.session,
          dispatcher: this.dispatcher,
        }),
      },
    ]);

    // Handlers
    const promptHandler = createPromptHandler({
      session: this.session,
      dispatcher: this.dispatcher,
      getPlannedThreadId: () => this.plannedThreadId,
      setPlannedThreadId: (id) => {
        this.plannedThreadId = id as `${string}-${string}-${string}-${string}-${string}`;
      },
    });

    const commandHandler = createCommandHandler({
      commandManager: this.commandManager,
    });

    const cancelHandler = createCancelHandler({
      session: this.session,
      dispatcher: this.dispatcher,
      onExit: exitProcess,
    });

    const modelSelectHandler = createModelSelectHandler({
      home,
      agent: cubeAgent,
      dispatcher: this.dispatcher,
    });

    const threadSelectHandler = createThreadSelectHandler({
      session: this.session,
      dispatcher: this.dispatcher,
    });

    // Action Router
    this.dispatcher.setActionHandler(async (action: CubeAction) => {
      switch (action.type) {
        case "prompt:submit":
          return promptHandler(action.content);
        case "command:submit":
          return commandHandler(action.name, action.argument);
        case "model:select":
          return modelSelectHandler(action.modelId, action.reasoningEffort);
        case "thread:select":
          return threadSelectHandler(action.threadId);
        case "turn:cancel":
          return cancelHandler();
        case "app:exit":
          return exitProcess();
      }
    });

    // Mastra Session Event Translation
    this.session.subscribe((event: any) => {
      if (event.type === "display_state_changed" && event.displayState) {
        const { currentMessage, activeTools } = event.displayState;

        if (activeTools && typeof activeTools === "object") {
          for (const [toolId, tool] of Object.entries<any>(activeTools)) {
            if (tool) {
              this.dispatcher.emit({
                type: "turn:tool",
                tool: {
                  id: toolId,
                  name: tool.name || toolId,
                  args: tool.args || tool.input,
                  status: tool.status || "running",
                  partialResult: tool.partialResult,
                  result: tool.result,
                  shellOutput: tool.output,
                },
              });
            }
          }
        }

        if (currentMessage && currentMessage.role === "assistant") {
          const text = extractMessageText(currentMessage);
          if (text.trim()) {
            this.dispatcher.emit({
              type: "message:upsert",
              message: {
                id: currentMessage.id,
                role: "assistant",
                content: text,
                status: event.displayState.isRunning ? "streaming" : "done",
              },
            });
          }
        }
      }

      if (
        event.type === "message_start" ||
        event.type === "message_update" ||
        event.type === "message_end" ||
        event.type === "agent_message"
      ) {
        const msg = event.message || event;
        if (msg && msg.role === "assistant") {
          const text = extractMessageText(msg.content || msg);
          if (text.trim()) {
            this.dispatcher.emit({
              type: "turn:delta",
              text,
            });
          }
        }
      }
    });

    // Emit initial info event
    this.emitInitialState();
  }

  public emitInitialState(): void {
    if (!this.config || !this.workspacePaths) return;
    this.dispatcher.emit({
      type: "state:info",
      info: {
        model: this.config.model,
        workspace: this.workspacePaths.root,
        agentMd: "AGENT.md (active)",
        threadId: "default",
      },
    });
  }
}
