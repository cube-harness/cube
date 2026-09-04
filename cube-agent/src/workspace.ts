import { Workspace, LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS } from "@mastra/core/workspace";
import type { WorkspaceManager } from "@cube/workspace";

export const createMastraWorkspace = async (workspace: WorkspaceManager): Promise<Workspace> => {
  const projectPaths = await workspace.getPaths();
  return new Workspace({
    filesystem: new LocalFilesystem({ basePath: projectPaths.root }),
    skills: projectPaths.skillsDirs,
    bm25: true,
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
      workingDirectory: projectPaths.root,
      env: process.env,
      instructions: ({ defaultInstructions }) =>
        [
          defaultInstructions,
          process.platform === "win32"
            ? "Commands run through cmd.exe. Use native syntax (`dir`, `%VAR%`, `&&` to chain, `%errorlevel%` for exit codes)."
            : "Commands run through the host POSIX shell (bash/sh semantics).",
          "Commands that ask for confirmation (Y/N), open an editor, or use a pager will hang with no TTY — always pass non-interactive/force flags: `-y`/`-f`/`-q`/`--yes`, `-m` for git commit, `--no-pager` for git log/diff, `date /t`/`time /t` instead of `date`/`time` on Windows.",
          "Quote arguments containing spaces or special characters.",
          "For long-running or background processes, don't wait synchronously — start them and use get_process to poll output.",
          `Working directory is fixed at ${projectPaths.root} — use relative paths from there unless an absolute path is required.`,
        ].join("\n"),
    }),
  });
};
