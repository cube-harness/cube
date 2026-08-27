import crypto from "node:crypto";
import {
  createCubeMastra,
  reloadCubeAgentSoul,
  runWithCubeLogContext,
  type CubeMastraComposition,
  type Session,
} from "@cube/agent";
import { CubeHome, ConfigStore, Workspace, createBootstrap, HistoryStore } from "@cube/workspace";
import { CommandManager } from "./command-manager.js";
import { ActionDispatcher } from "./dispatcher.js";
import type {
  CubeUIAction,
  CubeUIEventListener,
  SlashCommandSuggestion,
} from "./contracts/ui.contract.js";

import { createPromptHandler } from "./handlers/prompt.handler.js";
import { createCommandHandler } from "./handlers/command.handler.js";
import { createModelSelectHandler } from "./handlers/model-select.handler.js";
import { createThreadSelectHandler } from "./handlers/thread-select.handler.js";
import { createThemeSelectHandler } from "./handlers/theme-select.handler.js";
import { createTitleSelectHandler } from "./handlers/title-select.handler.js";
import { createStatusLineSelectHandler } from "./handlers/statusline-select.handler.js";
import { createResumeCommand } from "./commands/resume.command.js";
import { createNewCommand } from "./commands/new.command.js";
import { createExitCommand } from "./commands/exit.command.js";
import { createCompactCommand } from "./commands/compact.command.js";
import { createModelCommand } from "./commands/model.command.js";
import { createHelpCommand } from "./commands/help.command.js";
import { createRenameCommand } from "./commands/rename.command.js";
import { createDeleteCommand } from "./commands/delete.command.js";
import { createForkCommand } from "./commands/fork.command.js";
import { createUsageCommand } from "./commands/usage.command.js";
import { createThemeCommand } from "./commands/theme.command.js";
import { createCopyCommand } from "./commands/copy.command.js";
import { createTitleCommand } from "./commands/title.command.js";
import { createStatusLineCommand } from "./commands/statusline.command.js";

export interface CubeRuntimeOptions {
  workspacePath?: string;
  onExit?: () => void;
}

export class CubeRuntime {
  public readonly dispatcher = new ActionDispatcher();
  public readonly commandManager: CommandManager;
  private readonly workspacePath: string;
  private plannedThreadId: `${string}-${string}-${string}-${string}-${string}`;
  private activeSession?: Session;
  private config?: any;
  private workspacePaths?: any;
  private composition?: CubeMastraComposition;
  private readonly onExit?: () => void;

  constructor(options: CubeRuntimeOptions = {}) {
    this.workspacePath = options.workspacePath || process.env.INIT_CWD || process.cwd();
    this.plannedThreadId =
      crypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`;
    this.onExit = options.onExit;

    this.commandManager = new CommandManager((message) => {
      this.dispatcher.emit({ type: "system:message", content: message });
    });
  }

  get suggestions(): SlashCommandSuggestion[] {
    return this.commandManager.suggestions;
  }

  get theme(): string {
    return this.config?.theme || "default";
  }

  get appTitle(): string[] {
    return this.config?.app_title || ["model", "workspace", "threadId"];
  }

  get statusLine(): string[] {
    return this.config?.status_line || ["model", "workspace", "agentMd", "threadId"];
  }

  get session(): Session {
    if (!this.activeSession) {
      throw new Error("CubeRuntime.start() must complete before accessing session");
    }
    return this.activeSession;
  }

  subscribe(listener: CubeUIEventListener): () => void {
    return this.dispatcher.subscribe(listener);
  }

  async dispatch(action: CubeUIAction): Promise<void> {
    await this.dispatcher.dispatch(action);
  }

  async getHistory(): Promise<string[]> {
    const entries = await HistoryStore(CubeHome()).read();
    return entries.map((e) => e.text);
  }

  async start(): Promise<void> {
    const home = CubeHome();
    await home.ensure();
    await createBootstrap(home).run();

    const workspace = Workspace(home, this.workspacePath);
    this.workspacePaths = await workspace.getPaths();
    this.config = await ConfigStore(home).read();
    this.composition = await createCubeMastra(home, workspace);

    this.activeSession = await this.composition.controller.createSession({
      resourceId: this.workspacePaths.root,
    });
    await this.session.permissions.setForCategory({ category: "other", policy: "allow" });
    for (const configuredName of this.config.permissions.require_approval_for as string[]) {
      const exposedName = configuredName.startsWith("mastra_workspace_")
        ? configuredName
        : `mastra_workspace_${configuredName}`;
      await this.session.permissions.setForTool({ toolName: configuredName, policy: "ask" });
      await this.session.permissions.setForTool({ toolName: exposedName, policy: "ask" });
    }

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
      this.activeSession?.abort();
      if (this.activeSession && this.activeSession.thread.getId() !== null) {
        await this.activeSession.thread.clearAndReleaseLock().catch(() => undefined);
      }
      await this.composition?.shutdown();
      this.onExit?.();
    };

    // Register all commands
    this.commandManager.registerMany([
      {
        name: "/resume",
        description: "Switch to a previous conversation thread",
        handler: createResumeCommand({
          session: this.session,
          dispatcher: this.dispatcher,
        }),
      },
      {
        name: "/threads",
        description: "Alias for /resume",
        handler: createResumeCommand({
          session: this.session,
          dispatcher: this.dispatcher,
        }),
      },
      {
        name: "/new",
        description: "Start a new conversation thread",
        handler: createNewCommand({
          session: this.session,
          dispatcher: this.dispatcher,
          reloadSoul: async () => {
            if (this.composition?.agent) {
              await reloadCubeAgentSoul(this.composition.agent, home);
            }
          },
          onNewThread: () => {
            this.plannedThreadId =
              crypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`;
          },
        }),
      },
      {
        name: "/exit",
        description: "Exit Cube",
        handler: createExitCommand({ shutdown: exitProcess }),
      },
      {
        name: "/compact",
        description: "Finalize pending observational memory",
        handler: createCompactCommand({
          getThreadId: () => this.session.thread.getId(),
          isTurnActive: () => this.session.run.isRunning(),
          showMessage: (msg) => this.dispatcher.emit({ type: "system:message", content: msg }),
        }),
      },
      {
        name: "/model",
        description: "View and select models",
        handler: createModelCommand({
          home,
          dispatcher: this.dispatcher,
          isTurnActive: () => this.session.run.isRunning(),
        }),
      },
      {
        name: "/help",
        description: "Show available commands",
        handler: createHelpCommand({
          commandManager: this.commandManager,
          showMessage: (msg) => this.dispatcher.emit({ type: "system:message", content: msg }),
        }),
      },
      {
        name: "/rename",
        description: "Rename current thread (/rename <title>)",
        handler: createRenameCommand({
          session: this.session,
          dispatcher: this.dispatcher,
          isTurnActive: () => this.session.run.isRunning(),
        }),
      },
      {
        name: "/delete",
        description: "Delete a conversation thread",
        handler: createDeleteCommand({
          session: this.session,
          dispatcher: this.dispatcher,
          isTurnActive: () => this.session.run.isRunning(),
        }),
      },
      {
        name: "/fork",
        description: "Clone current thread into a new branch",
        handler: createForkCommand({
          session: this.session,
          dispatcher: this.dispatcher,
          isTurnActive: () => this.session.run.isRunning(),
        }),
      },
      {
        name: "/usage",
        description: "Show token usage & context window metrics",
        handler: createUsageCommand({
          home,
          session: this.session,
          dispatcher: this.dispatcher,
        }),
      },
      {
        name: "/theme",
        description: "Change color scheme (/theme [name])",
        handler: createThemeCommand({
          home,
          dispatcher: this.dispatcher,
        }),
      },
      {
        name: "/copy",
        description: "Copy last response as markdown",
        handler: createCopyCommand({
          session: this.session,
          dispatcher: this.dispatcher,
        }),
      },
      {
        name: "/title",
        description: "Configure terminal title",
        handler: createTitleCommand({
          dispatcher: this.dispatcher,
        }),
      },
      {
        name: "/statusline",
        description: "Configure footer status line",
        handler: createStatusLineCommand({
          dispatcher: this.dispatcher,
        }),
      },
    ]);

    // Handlers
    const runWithThreadLogContext = <T>(callback: () => T): T => {
      const threadId = this.session.thread.getId();
      return runWithCubeLogContext(threadId ? { threadId } : {}, callback);
    };

    const promptHandler = createPromptHandler({
      home,
      session: this.session,
      dispatcher: this.dispatcher,
      getPlannedThreadId: () => this.plannedThreadId,
      setPlannedThreadId: (id) => {
        this.plannedThreadId = id as `${string}-${string}-${string}-${string}-${string}`;
      },
      runWithThreadLogContext,
      reloadSoul: async () => {
        if (this.composition?.agent) {
          await reloadCubeAgentSoul(this.composition.agent, home);
        }
      },
    });

    const commandHandler = createCommandHandler({
      home,
      commandManager: this.commandManager,
      getThreadId: () => this.session.thread.getId(),
    });

    const modelSelectHandler = createModelSelectHandler({
      home,
      agent: this.composition.agent,
      dispatcher: this.dispatcher,
    });

    const threadSelectHandler = createThreadSelectHandler({
      session: this.session,
      dispatcher: this.dispatcher,
    });

    const themeSelectHandler = createThemeSelectHandler({
      home,
      dispatcher: this.dispatcher,
    });

    const titleSelectHandler = createTitleSelectHandler({
      home,
      dispatcher: this.dispatcher,
    });

    const statusLineSelectHandler = createStatusLineSelectHandler({
      home,
      dispatcher: this.dispatcher,
    });

    // Action Router
    this.dispatcher.setActionHandler(async (action: CubeUIAction) => {
      switch (action.type) {
        case "prompt:submit":
          return promptHandler(action.content);
        case "command:submit":
          return commandHandler(action.name, action.argument);
        case "model:select":
          return modelSelectHandler(action.modelId, action.reasoningEffort);
        case "thread:select":
          return threadSelectHandler(action.threadId);
        case "theme:select":
          return themeSelectHandler(action.themeId);
        case "title:select":
          return titleSelectHandler(action.appTitle);
        case "statusline:select":
          return statusLineSelectHandler(action.statusLine);
        case "app:exit":
          return exitProcess();
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
