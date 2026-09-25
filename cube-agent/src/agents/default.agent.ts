import { createCodingAgent } from "@mastra/core/coding-agent";
import type { IMastraLogger } from "@mastra/core/logger";
import { type CubeConfig, type HomeManager, type WorkspaceManager } from "@cube/workspace";
import { createMastraWorkspace } from "../workspace.js";
import { webFetchTool, webSearchTool } from "@mastra/core/tools";
import { createCubeTools, type CubeTools } from "../tools/cube-tools.js";
import { getCanonicalModelId } from "../gateways/types.js";
import {
  formatAgentsContext,
  instructionInfo,
  loadInstructionSnapshot,
  refreshInstructionSnapshot,
  type InstructionSnapshot,
} from "../prompts/system.prompt.js";
import { createAgentsMdProcessor } from "../processors/agents-md.processor.js";

export const buildModelConfig = (modelId: string, effort?: string): Record<string, any> => {
  const canonicalModelId = getCanonicalModelId(modelId);
  const providerOptions: Record<string, any> = {};

  if (
    canonicalModelId.startsWith("google/gemini-3") &&
    effort &&
    effort !== "none" &&
    effort !== "default"
  ) {
    providerOptions.google = {
      thinkingConfig: { thinkingLevel: effort, includeThoughts: true },
    };
  } else if (canonicalModelId.startsWith("google/")) {
    if (effort === "max" || effort === "xhigh") {
      providerOptions.google = {
        thinkingConfig: { thinkingBudget: 32768, includeThoughts: true },
      };
    } else if (effort === "high") {
      providerOptions.google = {
        thinkingConfig: { thinkingBudget: 24576, includeThoughts: true },
      };
    } else if (effort === "medium") {
      providerOptions.google = {
        thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
      };
    } else if (effort === "low" || effort === "minimal") {
      providerOptions.google = {
        thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
      };
    } else if (effort === "none") {
      providerOptions.google = { thinkingConfig: { thinkingBudget: 0 } };
    }
  } else if (canonicalModelId.startsWith("anthropic/")) {
    if (effort && effort !== "none" && effort !== "default") {
      const budget =
        effort === "max" || effort === "xhigh"
          ? 32768
          : effort === "high"
            ? 16384
            : effort === "medium"
              ? 8192
              : 2048;
      providerOptions.anthropic = { thinking: { type: "enabled", budgetTokens: budget } };
    }
  } else if (/^cube-oauth\/xai\/grok-4\.5(?:$|-)/.test(modelId)) {
    if (effort && ["low", "medium", "high", "xhigh"].includes(effort)) {
      providerOptions.openai = { reasoningEffort: effort };
    }
  } else if (canonicalModelId.startsWith("openai/")) {
    if (effort && effort !== "none" && effort !== "default") {
      providerOptions.openai = { reasoningEffort: effort, reasoningSummary: "auto" };
    }
  } else if (canonicalModelId.startsWith("openrouter/")) {
    if (effort === "default") {
      providerOptions.openrouter = { reasoning: { enabled: true, exclude: false } };
    } else if (effort) {
      providerOptions.openrouter = { reasoning: { effort, exclude: false } };
    }
  }

  return {
    id: "cube-model",
    model: modelId,
    maxRetries: 2,
    enabled: true,
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
  };
};

export const updateCubeAgentModel = (
  agent: { model: unknown; setToolModel?: (modelId: string) => void },
  modelId: string,
  effort?: string,
): void => {
  const modelConfig = buildModelConfig(modelId, effort);
  agent.model = [modelConfig];
  agent.setToolModel?.(modelId);
};

export const reloadCubeAgentInstructions = async (
  agent: Awaited<ReturnType<typeof createCubeAgent>>,
  home: HomeManager,
  workspace: WorkspaceManager,
  includeDiscovered = false,
): Promise<void> => {
  const base = await loadInstructionSnapshot(home, workspace);
  agent.installInstructions(
    includeDiscovered
      ? await refreshInstructionSnapshot(workspace, base, agent.readInstructions())
      : base,
  );
};

export const createCubeAgent = async (
  home: HomeManager,
  workspace: WorkspaceManager,
  config: CubeConfig,
  logger?: IMastraLogger,
  tools?: CubeTools,
) => {
  let snapshot = await loadInstructionSnapshot(home, workspace);
  const startupSnapshot = structuredClone(snapshot);
  let context = formatAgentsContext(snapshot.sources);
  const paths = await workspace.getPaths();
  const cubeTools = tools ?? createCubeTools(paths.root);
  let activeModel = config.model;
  const executionInstructions = [
    `Workspace: ${paths.root}. File tools are restricted to this root; commands run on the host and are NOT an OS sandbox.`,
    process.platform === "win32"
      ? `execute_command uses ${process.env.ComSpec || "cmd.exe"}. Use cmd syntax (dir, %VAR%, date /t, time /t).`
      : "execute_command uses /bin/sh. Use POSIX shell syntax.",
    "Commands have no TTY. Avoid interactive prompts, editors and pagers; use non-interactive options only when appropriate for the requested action.",
    "Supply a brief reason for each command. cwd defaults to the workspace root. Use background: true for long-running work, then get_process or kill_process with its returned process_id.",
    "Use the exposed file mutation tools for edits. File mutations accept UTF-8 text; binary/media editing is unsupported. Read, list and grep paths are relative to the workspace root.",
  ].join("\n");
  const effort = config.model_config?.reasoning_effort;
  const modelConfig = buildModelConfig(config.model, effort);
  const mastraWorkspace = await createMastraWorkspace(workspace);

  const agent = createCodingAgent({
    id: "cube-agent",
    name: "Cube Agent",
    model: [modelConfig as any],
    instructions: [
      { role: "system", content: snapshot.soul },
      { role: "system", content: executionInstructions },
    ],
    inputProcessors: [
      createAgentsMdProcessor(
        () => context,
        async (targets) => {
          const explored = new Set(snapshot.explored);
          const discovered = await workspace.discoverContextFiles(targets, explored, paths.root);
          if (explored.size === snapshot.explored.length) return;
          const next = {
            ...snapshot,
            sources: [...discovered, ...snapshot.sources],
            explored: [...explored],
          };
          await result.onInstructionsDiscovered?.(next);
          snapshot = next;
          context = formatAgentsContext(snapshot.sources);
          result.instructionInfo = instructionInfo(snapshot);
        },
      ),
    ],
    workspace: mastraWorkspace,
    skills: [home.getSkillDir()],
    basePath: paths.root,
    tools: () => ({
      ...cubeTools.forModel(activeModel),
      fetch: webFetchTool,
    }),
    defaultOptions: ({ requestContext }) => {
      const controller = requestContext.get("controller") as { threadId?: string } | undefined;
      let previousType: string | undefined;
      let runId: string | undefined;
      const log = (event: string, fields: Record<string, unknown> = {}) => {
        logger?.info("Agent stream boundary", {
          event,
          runId,
          model: activeModel,
          ...(controller?.threadId ? { threadId: controller.threadId } : {}),
          ...fields,
        });
      };
      return {
        onChunk: (chunk) => {
          runId = chunk.runId;
          // Log phase changes, not every token or any prompt/tool/provider content.
          if (chunk.type === previousType) return;
          previousType = chunk.type;
          const payload = "payload" in chunk ? chunk.payload : undefined;
          log(chunk.type, {
            ...(payload && "toolName" in payload ? { toolName: payload.toolName } : {}),
            ...(payload && "toolCallId" in payload ? { toolCallId: payload.toolCallId } : {}),
          });
        },
        onStepFinish: ({ finishReason }) => {
          log("step-finish", { finishReason });
          previousType = undefined;
        },
        onFinish: ({ finishReason }) => log("finish", { finishReason }),
        onAbort: () => log("abort"),
        onError: () => log("error"),
      };
    },
  });

  if (logger) agent.__registerPrimitives({ logger });
  const result = Object.assign(agent, {
    setToolModel: (modelId: string) => {
      activeModel = modelId;
    },
    disposeTools: cubeTools.dispose,
    instructionInfo: instructionInfo(snapshot),
    onInstructionsDiscovered: undefined as
      | ((snapshot: InstructionSnapshot) => Promise<void>)
      | undefined,
    readInstructions: (): InstructionSnapshot => structuredClone(snapshot),
    installInstructions: (next: InstructionSnapshot): void => {
      const replacement = structuredClone(next);
      const formatted = formatAgentsContext(replacement.sources);
      agent.__updateInstructions([
        { role: "system", content: replacement.soul },
        { role: "system", content: executionInstructions },
      ]);
      snapshot = replacement;
      context = formatted;
      result.instructionInfo = instructionInfo(replacement);
    },
    refreshInstructions: (saved: unknown) =>
      refreshInstructionSnapshot(workspace, startupSnapshot, saved),
  });
  return result;
};
