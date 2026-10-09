import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import type { MastraStorage } from "@mastra/core/storage";
import type { MastraToolInvocationOptions, ToolHooks } from "@mastra/core/tools";
import { Memory } from "@mastra/memory";
import { webFetchTool } from "@mastra/core/tools";
import { createMastraWorkspace } from "../workspace.js";
import { cubeAskUserTool } from "../tools/ask-user.tool.js";
import { formatAgentsContext } from "../prompts/system.prompt.js";
import { formatMemorySnapshot } from "../processors/memory.processor.js";
import { buildModelConfig } from "./default.agent.js";
import { createSkillsProcessor } from "../processors/skills.processor.js";
import {
  WorkspaceManager,
  type CubeConfig,
  type HomeManager,
  type ReasoningEffort,
  type SubagentDefinition,
} from "@cube/workspace";
import path from "node:path";
import { WORKER_AGENT } from "./worker.agent.js";
import { EXPLORE_AGENT } from "./explore.agent.js";
import { resolveCubeToolPermission } from "../permission.js";
import { createCubeTools, type CubeTools } from "../tools/cube-tools.js";
import type { InstructionSnapshot } from "../prompts/system.prompt.js";
import { restrictCubeSkills, type CubeSkills } from "../skills.js";
import type { CubeMcp } from "../mcp/client.js";

export const BUILTIN_SUBAGENTS: readonly SubagentDefinition[] = [EXPLORE_AGENT, WORKER_AGENT];

export type NativeSubagentInput = {
  prompt: string;
  threadId?: string | null;
  resourceId?: string | null;
  instructions?: string | null;
  maxSteps?: number | null;
};
export type NativeInvocation = {
  id: string;
  projectRoot: string;
  executionRoot: string;
  definition: SubagentDefinition;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  instructions: InstructionSnapshot;
};
export type NativeSubagentResult = {
  text: string;
  threadId?: string;
  resourceId?: string;
  runId?: string;
  finishReason?: string;
  toolActivity: ChildToolActivity[];
};
export type NativeSubagentGate = {
  runId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  suspendPayload: unknown;
  approval: boolean;
};
export type SubagentDispatchRequest = {
  role: string;
  input: NativeSubagentInput;
  projectRoot: string;
  parentThreadId: string;
  runId: string;
  toolCallId: string;
};
export type NativeSubagentExecution = {
  agent: Agent;
  tools: CubeTools;
  history: Pick<NativeSubagentResult, "threadId" | "resourceId" | "runId">;
  run(
    input: NativeSubagentInput,
    options: MastraToolInvocationOptions,
    suspend: (gate: NativeSubagentGate) => Promise<unknown>,
  ): Promise<NativeSubagentResult>;
  dispose(): Promise<void>;
};

export function createNativeSubagents(options: {
  home: HomeManager;
  config: CubeConfig;
  projectRoot: string;
  storage: MastraStorage;
  parent: Agent;
  skills: CubeSkills;
  mcp: Pick<CubeMcp, "readTools" | "readToolNames">;
  readPermissions: () => CubeConfig["permissions"];
}) {
  const key = "cube.subagentInvocation";
  let definitions: readonly SubagentDefinition[] = BUILTIN_SUBAGENTS;
  let dispatch: ((request: SubagentDispatchRequest) => Promise<{ id: string }>) | undefined;
  const invocations = new Map<string, Agent>();
  const catalog = () =>
    Object.fromEntries(
      definitions.map((definition) => [
        definition.name,
        new Agent({
          id: `cube-role-${definition.name}`,
          name: definition.name,
          model: options.config.model,
          description: `${definition.description}. Runs in the background; completion is delivered to this thread. Supply relevant constraints and expected evidence.`,
          instructions: definition.instructions,
        }),
      ]),
    );
  let listed = catalog();
  function readAgents(context?: RequestContext): Record<string, Agent> {
    const id = context?.get(key) as string | undefined;
    if (!id) return listed;
    const agent = invocations.get(id);
    if (!agent) throw new Error("Subagent invocation is unavailable");
    return { [agent.name]: agent };
  }
  const hooks: ToolHooks = {
    beforeToolCall: async ({ toolName, input, context }) => {
      if (
        !toolName.startsWith("agent-") ||
        !definitions.some((role) => `agent-${role.name}` === toolName)
      )
        return;
      const ctx = context as MastraToolInvocationOptions;
      const controller = ctx.requestContext?.get("controller") as { threadId?: string } | undefined;
      const threadId = controller?.threadId;
      const runId = ctx.requestContext?.get("cubeBackgroundRunId") as string | undefined;
      if (!threadId || !runId || !ctx.toolCallId || !dispatch)
        throw new Error("Delegation requires an active parent run");
      // Native delegation supplies parent memory IDs before this hook; never reuse them for a child.
      const {
        threadId: _threadId,
        resourceId: _resourceId,
        ...assignment
      } = input as NativeSubagentInput;
      const job = await dispatch({
        role: toolName.slice(6),
        input: assignment,
        projectRoot: options.projectRoot,
        parentThreadId: threadId,
        runId,
        toolCallId: ctx.toolCallId,
      });
      return {
        proceed: false,
        output: {
          text: `Background subagent accepted: ${job.id}. Completion will be delivered automatically in this thread.`,
        },
      };
    },
  };
  async function prepare(inputInvocation: NativeInvocation): Promise<NativeSubagentExecution> {
    const invocation = structuredClone(inputInvocation);
    if (invocations.has(invocation.id)) throw new Error("Subagent is already prepared");
    const { definition } = invocation;
    const skills = restrictCubeSkills(options.skills, definition.skills);
    if (definition.skills) {
      const available = await skills.list();
      for (const name of definition.skills)
        if (!available.some((skill) => skill.name === name && skill.enabled))
          throw new Error(`Unavailable child skill: ${name}`);
    }
    options.mcp.readToolNames(definition.mcpServers);
    const tools = createCubeTools(
      invocation.executionRoot,
      () => options.readPermissions().workspace_only,
      options.config.background_tasks,
      invocation.projectRoot,
      (name) => resolveCubeToolPermission(name, options.readPermissions()) === "ask",
    );
    try {
      const workspace = await createMastraWorkspace(
        new WorkspaceManager(options.home, invocation.executionRoot),
        skills,
        () => options.readPermissions().workspace_only,
      );
      const baseline = structuredClone(invocation.instructions);
      if (invocation.executionRoot !== invocation.projectRoot)
        baseline.sources = baseline.sources.map((source) => {
          const remap = (value: string) => {
            const rel = path.relative(invocation.projectRoot, value);
            return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
              ? path.join(invocation.executionRoot, rel)
              : value;
          };
          return {
            ...source,
            path: remap(source.path),
            scope: source.scope === "global" ? "global" : remap(source.scope),
          };
        });
      const history: NativeSubagentExecution["history"] = {};
      const agent = new Agent({
        id: `cube-role-${definition.name}-${invocation.id}`,
        name: definition.name,
        description: definition.description,
        model: [buildModelConfig(invocation.modelId, invocation.reasoningEffort) as any],
        memory: new Memory({
          storage: options.storage,
          vector: false,
          options: {
            lastMessages: false,
            generateTitle: false,
            semanticRecall: false,
            workingMemory: { enabled: false },
            observationalMemory: false,
          },
        }),
        workspace,
        skills: async ({ requestContext }) => (await skills.snapshot(requestContext)).globalPaths,
        instructions: [
          { role: "system", content: baseline.soul },
          { role: "system", content: definition.instructions },
          {
            role: "system",
            content: `Working directory: ${invocation.executionRoot}. Commands use ${process.platform === "win32" ? "cmd.exe" : "/bin/sh"} and have no TTY. Provide a brief command reason. Commands run on the host, not an OS sandbox. Your task/history are private. Report actual checks and changed files; worktree changes require deliberate integration.`,
          },
        ],
        tools: () =>
          Object.fromEntries(
            Object.entries({
              ...tools.forModel(invocation.modelId),
              ask_user: cubeAskUserTool,
              fetch: webFetchTool,
              ...options.mcp.readTools(definition.mcpServers),
            }).filter(([name]) => subagentAllowsTool(definition, name)),
          ),
        inputProcessors: [
          {
            id: "cube-role-history",
            processInput: ({ messageList }) => {
              const message = messageList.get.input
                .db()
                .find((message) => message.threadId && message.resourceId);
              if (message) {
                history.threadId = message.threadId;
                history.resourceId = message.resourceId;
              }
              return messageList;
            },
          },
          createSkillsProcessor(skills),
          {
            id: "cube-role-context",
            processLLMRequest: ({ prompt }) => {
              const texts = [
                formatAgentsContext(baseline.sources),
                formatMemorySnapshot(baseline.durableMemory),
              ].filter(Boolean);
              let index = 0;
              while (index < prompt.length && prompt[index]?.role === "system") index++;
              return {
                prompt: [
                  ...prompt.slice(0, index),
                  ...texts.map((text) => ({
                    role: "user" as const,
                    content: [{ type: "text" as const, text }],
                  })),
                  ...prompt.slice(index),
                ],
              };
            },
            processInputStep: ({ tools: available }) => {
              const allowed = Object.fromEntries(
                Object.entries(available ?? {}).filter(([name]) =>
                  subagentAllowsTool(definition, name),
                ),
              );
              return { tools: allowed, activeTools: Object.keys(allowed) };
            },
          },
        ],
        defaultOptions: () => ({
          onChunk: (chunk) => {
            history.runId = chunk.runId;
          },
          requireToolApproval: ({ toolName }) =>
            resolveCubeToolPermission(
              toolName,
              options.readPermissions(),
              options.mcp.readToolNames().includes(toolName) ? "ask" : "allow",
            ) === "ask",
          hooks: {
            beforeToolCall: ({ toolName }) => {
              if (
                resolveCubeToolPermission(
                  toolName,
                  options.readPermissions(),
                  options.mcp.readToolNames().includes(toolName) ? "ask" : "allow",
                ) === "deny"
              )
                return { proceed: false as const, output: `Permission denied: ${toolName}` };
            },
          },
        }),
      });
      invocations.set(invocation.id, agent);
      const requestContext = new RequestContext();
      requestContext.set(key, invocation.id);
      const native = await options.parent.getToolsForExecution({
        requestContext,
        threadId: invocation.id,
        resourceId: `${invocation.projectRoot}:subagent:${invocation.id}`,
        methodType: "stream",
        backgroundTaskEnabled: false,
        delegation: { messageFilter: () => [], hookErrorStrategy: "throw" },
      });
      const executor = native[`agent-${definition.name}`]?.execute;
      if (!executor) throw new Error("Native delegation tool is unavailable");
      return {
        agent,
        tools,
        history,
        async run(input, runOptions, suspend) {
          let resumed = false;
          let resumeData: unknown;
          let runId: string | undefined;
          let currentCall: any;
          let raw: any;
          do {
            resumed = false;
            raw = await executor(
              {
                ...input,
                threadId: invocation.id,
                resourceId: `${invocation.projectRoot}:subagent:${invocation.id}`,
                ...(runId ? { suspendedToolRunId: runId } : {}),
              },
              {
                ...runOptions,
                messages: [],
                requestContext,
                ...(resumeData !== undefined ? { resumeData } : {}),
                outputWriter: async (chunk: any) => {
                  const event = chunk.payload?.output ?? chunk;
                  const data = event.data ?? event.payload;
                  const type = event.type?.replace(/^data-/, "");
                  if (
                    ["tool-call", "tool-call-approval", "tool-call-suspended"].includes(type) &&
                    data?.toolCallId
                  ) {
                    const display =
                      event.metadata?.mastra?.toolPayloadTransform?.display?.approval?.transformed;
                    currentCall = { ...data, ...(display ? { args: display } : {}) };
                  }
                },
                suspend: async (payload: any, detail: any) => {
                  const approval = detail?.requireToolApproval;
                  const call = currentCall?.toolCallId
                    ? currentCall
                    : typeof approval === "object"
                      ? approval
                      : undefined;
                  if (!detail?.runId || !call?.toolCallId || !call.toolName)
                    throw new Error("Native suspension has no tool identity");
                  runId = detail.runId;
                  resumeData = await suspend({
                    runId: detail.runId,
                    toolCallId: call.toolCallId,
                    toolName: call.toolName,
                    args: call.args ?? {},
                    suspendPayload: payload,
                    approval: !!approval,
                  });
                  resumed = true;
                },
              },
            );
          } while (resumed && !runOptions.abortSignal?.aborted);
          if (runOptions.abortSignal?.aborted)
            throw runOptions.abortSignal.reason ?? new Error("Subagent cancelled");
          if (!raw?.text?.trim()) throw new Error("Subagent ended without a final report");
          return {
            text: raw.text,
            threadId: raw.subAgentThreadId,
            resourceId: raw.subAgentResourceId,
            runId: history.runId ?? runId,
            finishReason: raw.finishReason,
            toolActivity: (raw.subAgentToolResults ?? []).map((item: any) => ({
              toolName: item.toolName,
              toolCallId: item.toolCallId,
              isError: item.isError,
            })),
          };
        },
        async dispose() {
          await tools.dispose();
          invocations.delete(invocation.id);
        },
      };
    } catch (error) {
      await tools.dispose();
      invocations.delete(invocation.id);
      throw error;
    }
  }
  return {
    readAgents,
    hooks,
    prepare,
    setDefinitions(next: readonly SubagentDefinition[]) {
      definitions = structuredClone(next);
      listed = catalog();
    },
    setDispatch(next: typeof dispatch) {
      dispatch = next;
    },
  };
}

export type ChildToolActivity = {
  toolCallId: string;
  toolName: string;
  isError?: boolean;
  denied?: boolean;
};
export function subagentAllowsTool(definition: SubagentDefinition, name: string): boolean {
  if (name.startsWith("agent-")) return false;
  const bare = name.replace(/^controllerBuiltIn[._]/, "");
  if (
    [
      "subagent",
      "spawn_agent",
      "send_message",
      "list_agents",
      "get_agent",
      "interrupt_agent",
      "task_write",
      "task_update",
      "task_complete",
      "task_check",
      "submit_plan",
    ].includes(bare)
  )
    return false;
  if (definition.name === "explore" && EXPLORE_AGENT.disallowedTools!.includes(bare)) return false;
  return (
    !definition.disallowedTools?.includes(bare) &&
    (!definition.tools || definition.tools.includes(bare))
  );
}
