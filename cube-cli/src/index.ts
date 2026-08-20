import crypto from "node:crypto";
import { cubeController, cubeAgent, home, updateCubeAgentModel } from "@cube/agent";
import { CubeApp, type TuiAction } from "@cube/tui";
import { ConfigStore, Workspace, createBootstrap } from "@cube/workspace";
import { CommandManager } from "./command-manager.js";
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

export const run = async (): Promise<void> => {
  await home.ensure();
  await createBootstrap(home).run();

  const targetDir = process.env.INIT_CWD || process.cwd();
  const workspace = Workspace(home, targetDir);
  const workspacePaths = await workspace.getPaths();
  const config = await ConfigStore(home).read();

  let plannedThreadId = crypto.randomUUID();
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

  let app: ReturnType<typeof CubeApp> | undefined;

  const showSystemMessage = (content: string): void => {
    app?.addMessage({ role: "system", content });
  };

  const exitProcess = async (): Promise<void> => {
    if (session.thread.getId() !== null) {
      await session.thread.clearAndReleaseLock().catch(() => undefined);
    }
    app?.stop();
    process.exit(0);
  };

  const commandManager = new CommandManager(showSystemMessage);
  commandManager.registerMany([
    {
      name: "/resume",
      description: "Switch to a previous conversation thread",
      handler: createResumeCommandHandler({
        session,
        getApp: () => app,
        showMessage: showSystemMessage,
      }),
    },
    {
      name: "/threads",
      description: "Alias for /resume",
      handler: createResumeCommandHandler({
        session,
        getApp: () => app,
        showMessage: showSystemMessage,
      }),
    },
    {
      name: "/new",
      description: "Start a new conversation thread",
      handler: createNewCommandHandler({
        session,
        getApp: () => app,
        showMessage: showSystemMessage,
        onNewThread: () => {
          plannedThreadId = crypto.randomUUID();
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
        showMessage: showSystemMessage,
      }),
    },
    {
      name: "/model",
      description: "View and select models",
      handler: createModelCommandHandler({
        home,
        getApp: () => app,
        showMessage: showSystemMessage,
        isTurnActive: () => session.run.isRunning(),
        onModelSelected: (modelId, reasoningEffort) => {
          updateCubeAgentModel(cubeAgent, modelId, reasoningEffort);
        },
      }),
    },
    {
      name: "/help",
      description: "Show available commands",
      handler: createHelpCommandHandler({
        commandManager,
        showMessage: showSystemMessage,
      }),
    },
    {
      name: "/rename",
      description: "Rename current thread (/rename <title>)",
      handler: createRenameCommandHandler({
        session,
        getApp: () => app,
        showMessage: showSystemMessage,
        isTurnActive: () => session.run.isRunning(),
      }),
    },
    {
      name: "/delete",
      description: "Delete a conversation thread",
      handler: createDeleteCommandHandler({
        session,
        getApp: () => app,
        showMessage: showSystemMessage,
        isTurnActive: () => session.run.isRunning(),
      }),
    },
    {
      name: "/fork",
      description: "Clone current thread into a new branch",
      handler: createForkCommandHandler({
        session,
        getApp: () => app,
        showMessage: showSystemMessage,
        isTurnActive: () => session.run.isRunning(),
      }),
    },
    {
      name: "/usage",
      description: "Show token usage & context window metrics",
      handler: createUsageCommandHandler({
        home,
        session,
        showMessage: showSystemMessage,
      }),
    },
  ]);

  const extractMessageText = (raw: any): string => {
    if (typeof raw === "string") return raw;
    if (!raw) return "";
    if (typeof raw.text === "string") return raw.text;
    if (typeof raw.content === "string") return raw.content;
    if (Array.isArray(raw.parts)) {
      return raw.parts
        .map((p: any) => p.text || (p.data && (p.data.contents || p.data.text)) || "")
        .filter(Boolean)
        .join("\n");
    }
    if (raw.content && Array.isArray(raw.content.parts)) {
      return raw.content.parts
        .map((p: any) => p.text || (p.data && (p.data.contents || p.data.text)) || "")
        .filter(Boolean)
        .join("\n");
    }
    return "";
  };

  const handleTuiAction = async (action: TuiAction): Promise<void> => {
    switch (action.type) {
      case "prompt_submit": {
        try {
          if (session.thread.getId() === null) {
            const title = action.content.trim().replace(/\s+/g, " ") || "New Thread";
            await session.thread.create({ id: plannedThreadId, title });
            app?.setInfo({ threadId: plannedThreadId });
          }
          app?.addMessage({ role: "user", content: action.content });
          app?.startLoading("Thinking...");
          await session.sendMessage({ content: action.content });
          app?.stopLoading();
        } catch (err: unknown) {
          app?.stopLoading();
          showSystemMessage(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      case "command_submit": {
        await commandManager.execute(action.name, action.argument);
        return;
      }
      case "cancel": {
        if (session.run.isRunning()) {
          session.run.getAbortSignal();
          session.approval.cancel();
          app?.stopLoading();
        }
        return;
      }
    }
  };

  app = CubeApp({
    onAction: (action) => {
      void handleTuiAction(action).catch((error: unknown) => {
        showSystemMessage(error instanceof Error ? error.message : String(error));
      });
    },
    slashCommands: commandManager.suggestions,
    basePath: workspacePaths.root,
  });

  session.subscribe((event: any) => {
    if (event.type === "display_state_changed" && event.displayState) {
      const { currentMessage, activeTools } = event.displayState;

      if (activeTools && typeof activeTools === "object") {
        const runningTools = Object.entries<any>(activeTools).filter(
          ([_, t]) => t && (t.status === "running" || !t.status),
        );
        if (runningTools.length > 0) {
          const toolName = runningTools[0][1]?.name || runningTools[0][0];
          app?.updateLoading(`Running tool: ${toolName}`);
        }

        for (const [toolId, tool] of Object.entries<any>(activeTools)) {
          if (tool) {
            app?.upsertTool({
              id: toolId,
              name: tool.name || toolId,
              args: tool.args || tool.input,
              status: tool.status || "running",
              partialResult: tool.partialResult,
              result: tool.result,
              shellOutput: tool.output,
            });
          }
        }
      }

      if (currentMessage && currentMessage.role === "assistant") {
        const text = extractMessageText(currentMessage);
        if (text.trim()) {
          app?.stopLoading();
          app?.upsertMessage({
            id: currentMessage.id || "current-assistant-message",
            role: "assistant",
            content: text,
            status: event.displayState.isRunning ? "streaming" : "done",
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
          app?.stopLoading();
          app?.upsertMessage({
            id: msg.id || "current-assistant-message",
            role: "assistant",
            content: text,
            status: event.type === "message_end" ? "done" : "streaming",
          });
        }
      }
    }
  });

  const initialModelDisplay = `${config.model}${
    config.model_config?.reasoning_effort &&
    config.model_config.reasoning_effort !== "none"
      ? ` (${config.model_config.reasoning_effort})`
      : ""
  }`;

  app.setInfo({
    model: initialModelDisplay,
    workspace: workspacePaths.root,
    agentMd: "SOUL.md (active)",
    threadId: session.thread.getId() ?? "new thread",
  });

  process.once("SIGTERM", () => {
    void exitProcess();
  });

  app.start();
};

await run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
