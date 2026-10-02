import { Workspace, LocalFilesystem } from "@mastra/core/workspace";
import { DEFAULT_WORKSPACE_ONLY, type WorkspaceManager } from "@cube/workspace";
import { RequestContext } from "@mastra/core/request-context";
import type { CubeSkills } from "./skills.js";

export const createMastraWorkspace = async (
  workspace: WorkspaceManager,
  skills?: CubeSkills,
  workspaceOnly: boolean = DEFAULT_WORKSPACE_ONLY,
): Promise<Workspace> => {
  const projectPaths = await workspace.getPaths();
  return new Workspace({
    filesystem: new LocalFilesystem({ basePath: projectPaths.root, contained: workspaceOnly }),
    skills: skills ? async ({ requestContext }) =>
      (await skills.snapshot(requestContext ?? new RequestContext())).projectPaths : projectPaths.skillsDirs,
    tools: {
      enabled: false,
      mastra_workspace_read_file: { enabled: true, name: "read_file" },
      mastra_workspace_list_files: { enabled: true, name: "list_files" },
    },
  });
};
