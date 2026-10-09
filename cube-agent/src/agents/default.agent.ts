import { createCodingAgent } from "@mastra/core/coding-agent";
import type { Agent } from "@mastra/core/agent";
import type { ToolHooks } from "@mastra/core/tools";
import type { RequestContext } from "@mastra/core/request-context";
import type { IMastraLogger } from "@mastra/core/logger";
import {
  type CubeConfig,
  type HomeManager,
  type WorkspaceManager,
  type MemorySnapshot,
} from "@cube/workspace";
import type { createMemoryRecall } from "../tools/memory-recall.tool.js";
import { createMemoryProcessor } from "../processors/memory.processor.js";
import { createMastraWorkspace } from "../workspace.js";
import { createWorkspaceTools } from "@mastra/core/workspace";
import { webFetchTool } from "@mastra/core/tools";
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
import { createContextProcessor } from "../processors/context.processor.js";
import type { CubeContext, ContextLimits } from "../context.js";
import { createCubeSkills } from "../skills.js";
import { createSkillsProcessor } from "../processors/skills.processor.js";
import type { CubeMcp } from "../mcp/client.js";

export type CubeAgentOptions = {
  id?: string;
  snapshot?: InstructionSnapshot;
  skills?: Awaited<ReturnType<typeof createCubeSkills>>;
  agents?: (context: RequestContext) => Record<string, Agent>;
  toolHooks?: () => ToolHooks | undefined;
};

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
  const base = await agent.loadInstructions();
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
  contextManager?: {
    context: CubeContext;
    readModel: (modelId: string) => Promise<{ limits: ContextLimits }>;
    readMemory?: () => Promise<MemorySnapshot>;
    recallTool?: ReturnType<typeof createMemoryRecall>["tool"];
  },
  mcp?: Pick<CubeMcp, "readTools" | "readToolNames">,
  options: CubeAgentOptions = {},
) => {
  let snapshot: InstructionSnapshot = options.snapshot ? structuredClone(options.snapshot) : await loadInstructionSnapshot(
    home,
    workspace,
    contextManager?.readMemory,
  );
  let context = formatAgentsContext(snapshot.sources);
  const paths = await workspace.getPaths();
  const cubeTools =
    tools ??
    createCubeTools(paths.root, () => config.permissions.workspace_only, config.background_tasks);
  let activeModel = config.model;
  const executionInstructions = () =>
    [
      `Workspace: ${paths.root}. ${config.permissions.workspace_only ? "File paths and command cwd are restricted to this root." : "File paths and command cwd outside this root are allowed."} Commands run on the host and are NOT an OS sandbox.`,
      process.platform === "win32"
        ? `execute_command uses ${process.env.ComSpec || "cmd.exe"}. Use cmd syntax (dir, %VAR%, date /t, time /t).`
        : "execute_command uses /bin/sh. Use POSIX shell syntax.",
      "Commands have no TTY. Avoid interactive prompts, editors and pagers; use non-interactive options only when appropriate for the requested action.",
      "Supply a brief reason for each command. cwd defaults to the workspace root.",
      "Use the exposed file mutation tools for edits. File mutations accept UTF-8 text; binary/media editing is unsupported. Read and list paths are relative to the workspace root. Use execute_command for content searches with an available host search command.",
    ].join("\n");
  const effort = config.model_config?.reasoning_effort;
  const modelConfig = buildModelConfig(config.model, effort);
  const skills = options.skills ?? await createCubeSkills(home, workspace, config.skills.disabled);
  const mastraWorkspace = await createMastraWorkspace(
    workspace,
    skills,
    () => config.permissions.workspace_only,
  );
  const agent = createCodingAgent({
    id: options.id ?? "cube-agent",
    name: "Cube Agent",
    agents: ({ requestContext }) => options.agents?.(requestContext) ?? {},
    model: [modelConfig as any],
    instructions: [
      { role: "system", content: snapshot.soul },
      { role: "system", content: executionInstructions() },
    ],
    inputProcessors: [
      createSkillsProcessor(skills),
      createAgentsMdProcessor(
        () => context,
        async (targets, emit) => {
          const explored = new Set(snapshot.explored);
          const discovered = await workspace.discoverContextFiles(targets, explored, paths.root);
          if (explored.size === snapshot.explored.length) return;
          await emit(discovered);
          const next = {
            ...snapshot,
            sources: [...discovered, ...snapshot.sources],
            explored: [...explored],
          };
          await result.onInstructionsDiscovered?.(next);
          snapshot = next;
          result.instructionInfo = instructionInfo(snapshot);
        },
        (message) => contextManager?.context.protectedMessages.add(message),
      ),
      ...(contextManager?.readMemory
        ? [
            createMemoryProcessor(
              () => snapshot.durableMemory,
              contextManager.context.protectedMessages,
            ),
          ]
        : []),
      ...(contextManager
        ? [
            createContextProcessor(
              contextManager.context,
              () => contextManager.readModel(activeModel),
              () => JSON.stringify({ activeModel, snapshot }),
            ),
          ]
        : []),
    ],
    workspace: mastraWorkspace,
    skills: async ({ requestContext }) => (await skills.snapshot(requestContext)).globalPaths,
    basePath: paths.root,
    tools: () => ({
      ...cubeTools.forModel(activeModel),
      ...(contextManager?.recallTool ? { memory_recall: contextManager.recallTool } : {}),
      fetch: webFetchTool,
      ...mcp?.readTools(),
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
        hooks: options.toolHooks?.(),
        onChunk: (chunk) => {
          runId = chunk.runId;
          requestContext.set("cubeBackgroundRunId", runId);
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

  const result = Object.assign(agent, {
    cubeSkills: skills,
    listPermissionTools: async () => [
      ...new Set([
        ...cubeTools.names,
        ...(mcp?.readToolNames() ?? []),
        ...Object.keys(await agent.listTools({ resolveWebSearch: false })),
        ...Object.keys(await createWorkspaceTools(mastraWorkspace)),
        // Native skill tool names; listing permissions must not load SKILL.md files.
        "skill",
        "skill_read",
        "skill_search",
      ]),
    ],
    getActiveModelId: () => activeModel,
    loadInstructions: () => loadInstructionSnapshot(home, workspace, contextManager?.readMemory),
    setToolModel: (modelId: string) => {
      activeModel = modelId;
      contextManager?.context.invalidate();
    },
    disposeTools: cubeTools.dispose,
    instructionInfo: instructionInfo(snapshot),
    onInstructionsDiscovered: undefined as
      | ((snapshot: InstructionSnapshot) => Promise<void>)
      | undefined,
    readInstructions: (): InstructionSnapshot => structuredClone(snapshot),
    refreshPermissions: () => result.installInstructions(snapshot),
    installInstructions: (next: InstructionSnapshot): void => {
      contextManager?.context.invalidate();
      const replacement = structuredClone(next);
      const formatted = formatAgentsContext(replacement.sources);
      agent.__updateInstructions([
        { role: "system", content: replacement.soul },
        { role: "system", content: executionInstructions() },
      ]);
      snapshot = replacement;
      context = formatted;
      result.instructionInfo = instructionInfo(replacement);
    },
    refreshInstructions: async (saved: unknown) =>
      refreshInstructionSnapshot(workspace, await result.loadInstructions(), saved),
  });
  return result;
};
