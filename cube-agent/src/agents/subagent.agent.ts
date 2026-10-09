import { Mastra } from "@mastra/core";
import type { Agent } from "@mastra/core/agent";
import type { AgentControllerEvent, Session } from "@mastra/core/agent-controller";
import type { MemoryStorage } from "@mastra/core/storage";
import type { IMastraLogger } from "@mastra/core/logger";
import type { MastraModelGatewayInterface } from "@mastra/core/llm";
import { LibSQLStore } from "@mastra/libsql";
import {
  WorkspaceManager,
  type CubeConfig,
  type HomeManager,
  type ReasoningEffort,
  type SubagentDefinition,
} from "@cube/workspace";
import path from "node:path";
import { createCubeAgent } from "./default.agent.js";
import { createCubeController } from "./controller.js";
import { WORKER_AGENT } from "./worker.agent.js";
import { EXPLORE_AGENT } from "./explore.agent.js";
import { configureCubePermissions } from "../permission.js";
import { createCubeTools, type CubeTools } from "../tools/cube-tools.js";
import { runWithCubeLogContext } from "../logger.js";
import type { InstructionSnapshot } from "../prompts/system.prompt.js";
import type { CubeContext, ContextLimits } from "../context.js";
import { restrictCubeSkills, type CubeSkills } from "../skills.js";
import type { CubeMcp } from "../mcp/client.js";
import type { createMemoryRecall } from "../tools/memory-recall.tool.js";

export const BUILTIN_SUBAGENTS: readonly SubagentDefinition[] = [EXPLORE_AGENT, WORKER_AGENT];

export type ChildToolActivity = {
  toolCallId: string;
  toolName: string;
  isError?: boolean;
  denied?: boolean;
};
export type ChildRunResult = {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  text: string;
  error?: string;
  startedAt: number;
  completedAt: number;
  toolActivity: ChildToolActivity[];
};
export type CreateSubagentChildOptions = {
  id: string;
  projectRoot: string;
  executionRoot: string;
  cwd: string;
  definition: SubagentDefinition;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  instructions: InstructionSnapshot;
  readPermissions: () => CubeConfig["permissions"];
  home: HomeManager;
  config: CubeConfig;
  logger?: IMastraLogger;
  gateways: MastraModelGatewayInterface[];
  skills: CubeSkills;
  mcp: Pick<CubeMcp, "readTools" | "readToolNames">;
  recall?: ReturnType<typeof createMemoryRecall>["tool"];
  readModel: (id: string) => Promise<{ limits: ContextLimits }>;
  createContext: (getAgent: () => Agent, storage: () => Promise<MemoryStorage>) => CubeContext;
};
export type SubagentChild = {
  session: Session;
  agent: Awaited<ReturnType<typeof createCubeAgent>>;
  tools: CubeTools;
  context: CubeContext;
  run(content: string): Promise<ChildRunResult>;
  drain(): Promise<void>;
  dispose(): Promise<void>;
};

export function subagentAllowsTool(definition: SubagentDefinition, name: string): boolean {
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
  if (definition.name === "explore" && EXPLORE_AGENT.disallowedTools!.includes(bare))
    return false;
  return !definition.disallowedTools?.includes(bare) &&
    (!definition.tools || definition.tools.includes(bare));
}

export async function createSubagentChild(
  options: CreateSubagentChildOptions,
): Promise<SubagentChild> {
  const { home, id, projectRoot, executionRoot, definition, logger } = options;
  const skills = restrictCubeSkills(options.skills, definition.skills);
  const mcp = {
    readTools: () => options.mcp.readTools(definition.mcpServers),
    readToolNames: () => options.mcp.readToolNames(definition.mcpServers),
  };
  // Resolve explicit references before allocating child resources or calling a model.
  if (definition.skills) {
    const catalog = await skills.list();
    for (const name of definition.skills) {
      if (!catalog.some(skill => skill.name === name && skill.enabled))
        throw new Error(`Unavailable child skill: ${name}`);
    }
  }
  mcp.readToolNames();
  const config = structuredClone(options.config);
  config.model = options.modelId;
  config.model_config = { reasoning_effort: options.reasoningEffort };
  config.permissions = options.readPermissions();
  config.memory.generate_title.enabled = false;
  config.memory.semantic_recall.enabled = false;
  config.memory.embedder.enabled = false;
  config.memory.vector.enabled = false;
  const workspace = new WorkspaceManager(home, executionRoot);
  const tools = createCubeTools(
    executionRoot,
    () => options.readPermissions().workspace_only,
    config.background_tasks,
    projectRoot,
  );
  const store = new LibSQLStore({
    id: `cube-subagent-${id}`,
    url: `file:${home.getMemoryDbPath()}`,
  });
  let mastra: Mastra | undefined;
  let agent!: Awaited<ReturnType<typeof createCubeAgent>>;
  const storage = async () => {
    const memory = await store.getStore("memory");
    if (!memory) throw new Error("Child memory storage is unavailable");
    return memory;
  };
  const context = options.createContext(() => agent, storage);
  const snapshot = structuredClone(options.instructions);
  if (executionRoot !== projectRoot) {
    const remap = (source: string) => {
      const relative = path.relative(projectRoot, source);
      return relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
        ? path.join(executionRoot, relative)
        : source;
    };
    snapshot.sources = snapshot.sources.map((source) => ({
      ...source,
      path: remap(source.path),
      scope: source.scope === "global" ? "global" : remap(source.scope),
    }));
    snapshot.explored = snapshot.explored.map(remap);
  }
  const pending = new Set<Promise<void>>();
  const drain = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };
  try {
    agent = await createCubeAgent(
      home,
      workspace,
      config,
      logger,
      tools,
      {
        context,
        readModel: options.readModel,
        ...(options.recall
          ? { recallTool: options.recall, readMemory: async () => snapshot.durableMemory ?? null }
          : {}),
      },
      mcp,
      {
        id: `cube-subagent-${id}`,
        snapshot,
        skills,
        roleInstructions:
          `${definition.instructions}\nAssigned working directory: ${options.cwd}. ` +
          "Use that cwd for commands where appropriate. Your history is private; report evidence to your parent.",
        allowTool: (name) => subagentAllowsTool(definition, name),
      },
    );
    const controller = await createCubeController(
      home,
      workspace,
      config,
      agent,
      options.gateways,
      skills,
      undefined,
      {
        id: `cube-child-controller-${id}`,
        storage: store,
        allowTool: (name) => subagentAllowsTool(definition, name),
      },
    );
    mastra = new Mastra({
      agents: { child: agent },
      agentControllers: { child: controller },
      storage: store,
      logger: logger ?? false,
      gateways: Object.fromEntries(options.gateways.map((gateway) => [gateway.id, gateway])),
    });
    const session = await controller.createSession({
      resourceId: projectRoot,
      scope: id,
      id,
      ownerId: projectRoot,
      threadId: id,
    });
    await configureCubePermissions(session, options.readPermissions(), mcp.readToolNames());
    let current: { text: string; error?: string; runId?: string } | undefined;
    for (const method of ["stream", "resumeStream"] as const) {
      const original = agent[method].bind(agent) as (...args: any[]) => Promise<any>;
      agent[method] = ((...args: any[]) => {
        const output = original(...args);
        const attempt = current;
        const completion = output
          .then(async (result) => {
            if (attempt) attempt.runId = result.runId ?? attempt.runId;
            await result.consumeStream();
            if (attempt) attempt.text = (await result.text) ?? "";
          })
          .catch((error) => {
            if (attempt) attempt.error = error instanceof Error ? error.message : String(error);
          });
        pending.add(completion);
        void completion.finally(() => pending.delete(completion));
        return output;
      }) as typeof agent.stream & typeof agent.resumeStream;
    }
    let active: Promise<ChildRunResult> | undefined;
    let disposed = false;
    const run = (content: string): Promise<ChildRunResult> => {
      if (disposed || active)
        return Promise.reject(new Error("Child is disposed or already running"));
      const startedAt = Date.now();
      const attempt: NonNullable<typeof current> = { text: "" };
      current = attempt;
      const activity = new Map<string, ChildToolActivity>();
      active = runWithCubeLogContext({ threadId: id }, async () => {
        let finish!: (reason: "completed" | "failed" | "cancelled") => void;
        const ended = new Promise<"completed" | "failed" | "cancelled">((resolve) => {
          finish = resolve;
        });
        const stop = session.subscribe((event: AgentControllerEvent) => {
          attempt.runId ??= session.getCurrentRunId() ?? undefined;
          if (event.type === "error") attempt.error = event.error.message;
          if (event.type === "tool_start")
            activity.set(event.toolCallId, {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            });
          if (event.type === "tool_end")
            Object.assign(activity.get(event.toolCallId) ?? {}, {
              isError: event.isError,
              denied: event.denied,
            });
          if (event.type === "agent_end" && event.reason !== "suspended")
            finish(
              event.reason === "aborted"
                ? "cancelled"
                : event.reason === "error"
                  ? "failed"
                  : "completed",
            );
        });
        try {
          await configureCubePermissions(
            session,
            options.readPermissions(),
            mcp.readToolNames(),
          );
          await session.followUp({ content });
          const status = await ended;
          await drain();
          const runId = attempt.runId;
          if (!runId) throw new Error("Child turn ended without a native run identity");
          if (status === "completed" && !attempt.text.trim() && !attempt.error)
            attempt.error = "Child ended without a final report";
          return {
            runId,
            status: status === "completed" && attempt.error ? "failed" : status,
            text: attempt.text,
            ...(attempt.error ? { error: attempt.error } : {}),
            startedAt,
            completedAt: Date.now(),
            toolActivity: [...activity.values()],
          };
        } finally {
          stop();
        }
      });
      void active
        .finally(() => {
          active = undefined;
          current = undefined;
        })
        .catch(() => undefined);
      return active;
    };
    return {
      session,
      agent,
      tools,
      context,
      run,
      drain,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        session.abort();
        context.cancel();
        await tools.dispose();
        await Promise.allSettled([active, context.drain(), drain()]);
        session.thread.detachFromCurrent();
        await session.thread.clearAndReleaseLock();
        await controller.deleteSession({ resourceId: projectRoot, scope: id });
        await mastra!.shutdown();
      },
    };
  } catch (error) {
    context.cancel();
    await tools.dispose();
    await drain();
    await mastra?.shutdown();
    throw error;
  }
}
