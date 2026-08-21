#!/usr/bin/env node
import crypto from "node:crypto";
import { cubeController, cubeAgent, home } from "@cube/agent";
import { CubeApp } from "@cube/tui";
import { ConfigStore, Workspace, createBootstrap } from "@cube/workspace";
import { CommandManager } from "./command-manager.js";
import { ActionDispatcher } from "./dispatcher.js";
import type { CubeAction } from "./contracts/events.contract.js";

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

export * from "./contracts/events.contract.js";
export * from "./command-manager.js";
export * from "./dispatcher.js";

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

export const run = async (): Promise<void> => {
  await home.ensure();
  await createBootstrap(home).run();

  const targetDir = process.env.INIT_CWD || process.cwd();
  const workspace = Workspace(home, targetDir);
  const workspacePaths = await workspace.getPaths();
  const config = await ConfigStore(home).read();

  let plannedThreadId = crypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`;
  const session = await cubeController.createSession({
    resourceId: workspacePaths.root,
  });

  // Startup Normalization: Always start with clean unbound thread state
  const boundId = session.thread.getId();
  if (boundId) {
    const activeMessages = await session.thread.listActiveMessages({ limit: 1 });
    if (activeMessages.length > 0) {
      session.thread.detachFromCurrent();
      await session.thread.clearAndReleaseLock();
    } else {
      await session.thread.delete({ threadId: boundId });
    }
  }

  const dispatcher = new ActionDispatcher();

  const exitProcess = async (): Promise<void> => {
    if (session.thread.getId() !== null) {
      await session.thread.clearAndReleaseLock().catch(() => undefined);
    }
    process.exit(0);
  };

  const commandManager = new CommandManager((message) => {
    dispatcher.emit({ type: "system:message", content: message });
  });

  // Register all 8 slash commands
  commandManager.registerMany([
    {
      name: "/resume",
      description: "Switch to a previous conversation thread",
      handler: createResumeCommandHandler({
        session,
        dispatcher,
      }),
    },
    {
      name: "/threads",
      description: "Alias for /resume",
      handler: createResumeCommandHandler({
        session,
        dispatcher,
      }),
    },
    {
      name: "/new",
      description: "Start a new conversation thread",
      handler: createNewCommandHandler({
        session,
        dispatcher,
        onNewThread: () => {
          plannedThreadId = crypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`;
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
        getThreadId: () => session.thread.getId(),
        isTurnActive: () => session.run.isRunning(),
        showMessage: (msg) => dispatcher.emit({ type: "system:message", content: msg }),
      }),
    },
    {
      name: "/model",
      description: "View and select models",
      handler: createModelCommandHandler({
        home,
        dispatcher,
        isTurnActive: () => session.run.isRunning(),
      }),
    },
    {
      name: "/help",
      description: "Show available commands",
      handler: createHelpCommandHandler({
        commandManager,
        showMessage: (msg) => dispatcher.emit({ type: "system:message", content: msg }),
      }),
    },
    {
      name: "/rename",
      description: "Rename current thread (/rename <title>)",
      handler: createRenameCommandHandler({
        session,
        dispatcher,
        isTurnActive: () => session.run.isRunning(),
      }),
    },
    {
      name: "/delete",
      description: "Delete a conversation thread",
      handler: createDeleteCommandHandler({
        session,
        dispatcher,
        isTurnActive: () => session.run.isRunning(),
      }),
    },
    {
      name: "/fork",
      description: "Clone current thread into a new branch",
      handler: createForkCommandHandler({
        session,
        dispatcher,
        isTurnActive: () => session.run.isRunning(),
      }),
    },
    {
      name: "/usage",
      description: "Show token usage & context window metrics",
      handler: createUsageCommandHandler({
        home,
        session,
        dispatcher,
      }),
    },
  ]);

  // Create Handlers
  const promptHandler = createPromptHandler({
    session,
    dispatcher,
    getPlannedThreadId: () => plannedThreadId,
    setPlannedThreadId: (id) => {
      plannedThreadId = id as `${string}-${string}-${string}-${string}-${string}`;
    },
  });

  const commandHandler = createCommandHandler({
    commandManager,
  });

  const cancelHandler = createCancelHandler({
    session,
    dispatcher,
    onExit: exitProcess,
  });

  const modelSelectHandler = createModelSelectHandler({
    home,
    agent: cubeAgent,
    dispatcher,
  });

  const threadSelectHandler = createThreadSelectHandler({
    session,
    dispatcher,
  });

  // Action Dispatcher Router
  dispatcher.setActionHandler(async (action: CubeAction) => {
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

  // Forward Mastra Session Events to Dispatcher
  session.subscribe((event: any) => {
    if (event.type === "display_state_changed" && event.displayState) {
      const { currentMessage, activeTools } = event.displayState;

      if (activeTools && typeof activeTools === "object") {
        for (const [toolId, tool] of Object.entries<any>(activeTools)) {
          if (tool) {
            dispatcher.emit({
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
          dispatcher.emit({
            type: "message:upsert",
            message: {
              id: currentMessage.id || "current-assistant-message",
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
          dispatcher.emit({
            type: "turn:delta",
            text,
          });
        }
      }
    }
  });

  // Mount TUI Adapter
  const app = CubeApp({
    onAction: (action) => {
      void dispatcher.dispatch(action).catch((error: unknown) => {
        dispatcher.emit({
          type: "system:error",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    slashCommands: commandManager.suggestions,
    basePath: workspacePaths.root,
  });

  // Subscribe TUI to Runtime Events
  dispatcher.subscribe((event) => {
    app.handleEvent(event);
  });

  // Initial State Announcement
  dispatcher.emit({
    type: "state:info",
    info: {
      model: config.model,
      workspace: workspacePaths.root,
      agentMd: "AGENT.md (active)",
      threadId: "default",
    },
  });

  app.start();
};

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  run().catch((err) => {
    console.error("Fatal Runtime Error:", err);
    process.exit(1);
  });
}
