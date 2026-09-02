import { Workspace, LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS } from "@mastra/core/workspace";
import type { WorkspaceManager } from "@cube/workspace";

export const createMastraWorkspace = async (workspace: WorkspaceManager): Promise<Workspace> => {
  const paths = await workspace.getPaths();
  return new Workspace({
    filesystem: new LocalFilesystem({ basePath: paths.root }),
    tools: {
      [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { name: "read_file" },
      [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { name: "grep" },
      [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: { name: "list_file" },
      [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: { name: "write_file" },
      [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: { name: "edit_file" },
      [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: { name: "create_file" },
      [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: { name: "delete_file" },
      [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: { name: "file_stat" },
      [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: { name: "execute_command" },
      [WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT]: { name: "get_process" },
      [WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS]: { name: "kill_process" },
    },
    sandbox: new LocalSandbox({
      workingDirectory: paths.root,
      env: process.env,
      instructions: ({ defaultInstructions }) =>
        [
          defaultInstructions,
          process.platform === "win32"
            ? "Commands run through cmd.exe, not PowerShell. PowerShell cmdlets such as Get-Date must be invoked with `powershell -NoProfile -Command \"...\"`."
            : "Commands run through the host POSIX shell.",
        ].join("\n"),
    }),
  });
};
