import { getCanonicalModelId } from "../gateways/types.js";
import { createFileTools } from "./file.tools.js";
import { createCommandTools } from "./command.tools.js";
import { DEFAULT_WORKSPACE_ONLY } from "@cube/workspace";

export function usesPatch(modelId: string): boolean {
  const canonical = getCanonicalModelId(modelId).replace(/^openrouter\//, "");
  return /^openai\/(?:gpt-(?:[5-9]|[1-9]\d)(?:[.\-]|$)|codex(?:[.\-]|$))/.test(canonical);
}

export type CubeTools = ReturnType<typeof createCubeTools>;
export function createCubeTools(
  root: string,
  workspaceOnly: boolean | (() => boolean) = DEFAULT_WORKSPACE_ONLY,
  background?: Parameters<typeof createCommandTools>[2],
  projectRoot = root,
) {
  const files = createFileTools(root, workspaceOnly);
  const commands = createCommandTools(root, workspaceOnly, background, projectRoot);
  const { edit_file, write_file, apply_patch } = files.tools;
  return {
    processes: commands.processes,
    setTaskHandler: commands.setTaskHandler,
    names: Object.keys({ ...files.tools, ...commands.tools }),
    forModel: (modelId: string) => ({
      ...commands.tools,
      ...(usesPatch(modelId) ? { apply_patch } : { edit_file, write_file }),
    }),
    hasPreview: files.hasPreview,
    discardPreview: files.discardPreview,
    dispose: async () => {
      files.discardPreview();
      await commands.dispose();
    },
  };
}
