import { Workspace, LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS } from "@mastra/core/workspace";
import type { PinoLogger } from "@mastra/loggers";

export const createAgentWorkspace = (logger: PinoLogger, cwd: string) => {
  return new Workspace({
    filesystem: new LocalFilesystem({ basePath: cwd }),
    sandbox: new LocalSandbox({ workingDirectory: cwd }),
    bm25: true,
    lsp: true,
    tools: {
      hooks: {
        beforeToolCall: ({ toolName, input }) =>
          logger.debug("Tool called", { type: "tool_event", toolName, input }),
        afterToolCall: ({ toolName, error }) => {
          if (error) logger.error("Tool failed", { type: "tool_event", toolName, error });
        },
      },
      [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
        requireApproval: true,
        backgroundProcesses: {
          onStdout: (data, { pid }) =>
            logger.debug(data, { type: "process_output", stream: "stdout", pid }),
          onStderr: (data, { pid }) =>
            logger.debug(data, { type: "process_output", stream: "stderr", pid }),
          onExit: ({ pid, exitCode }) =>
            logger.info("Process exited", { type: "process_event", pid, exitCode }),
        },
      },
    },
  });
};
