import { Workspace, LocalFilesystem } from "@mastra/core/workspace";
import type { WorkspaceManager } from "@cube/workspace";

export const createMastraWorkspace = async (workspace: WorkspaceManager): Promise<Workspace> => {
  const projectPaths = await workspace.getPaths();
  return new Workspace({
    filesystem: new LocalFilesystem({ basePath: projectPaths.root }),
    skills: projectPaths.skillsDirs,
    tools: {
      enabled: false,
      mastra_workspace_read_file: { enabled: true, name: "read_file" },
      mastra_workspace_list_files: { enabled: true, name: "list_files" },
      mastra_workspace_grep: { enabled: true, name: "grep" },
    },
  });
};
