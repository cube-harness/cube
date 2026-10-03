import { Workspace, LocalFilesystem } from "@mastra/core/workspace";
import { DEFAULT_WORKSPACE_ONLY, type WorkspaceManager } from "@cube/workspace";
import { RequestContext } from "@mastra/core/request-context";
import type { CubeSkills } from "./skills.js";

export const createMastraWorkspace = async (
  workspace: WorkspaceManager,
  skills?: CubeSkills,
  workspaceOnly: boolean | (() => boolean) = DEFAULT_WORKSPACE_ONLY,
): Promise<Workspace> => {
  const projectPaths = await workspace.getPaths();
  const contained = new LocalFilesystem({ basePath: projectPaths.root, contained: true });
  const uncontained = new LocalFilesystem({ basePath: projectPaths.root, contained: false });
  return new Workspace({
    filesystem: typeof workspaceOnly === "function"
      ? () => workspaceOnly() ? contained : uncontained
      : workspaceOnly ? contained : uncontained,
    skills: skills ? async ({ requestContext }) =>
      (await skills.snapshot(requestContext ?? new RequestContext())).projectPaths : projectPaths.skillsDirs,
    tools: {
      enabled: false,
      mastra_workspace_read_file: { enabled: true, name: "read_file" },
      mastra_workspace_list_files: { enabled: true, name: "list_files" },
    },
  });
};
