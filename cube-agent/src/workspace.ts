import {
  Workspace,
  LocalFilesystem,
  LocalSandbox,
} from "@mastra/core/workspace";
import type { WorkspaceManager } from "@cube/workspace";

export const createMastraWorkspace = async (
  workspace: WorkspaceManager,
): Promise<Workspace> => {
  const paths = await workspace.getPaths();
  return new Workspace({
    filesystem: new LocalFilesystem({ basePath: paths.root }),
    sandbox: new LocalSandbox({
      workingDirectory: paths.root,
      env: process.env,
    }),
  });
};
