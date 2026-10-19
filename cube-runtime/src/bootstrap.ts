import {
  createCubeMastra,
  createCubeGateways,
  configureCubePermissions,
  reloadCubeAgentInstructions,
  runWithCubeLogContext,
  updateCubeAgentModel,
  toMastraRouterId,
  getCanonicalModelId,
  gatewayDescriptors,
  type CubeMastraComposition,
  type Session,
} from "@cube/agent";
import {
  ConfigStore,
  McpStore,
  AuthStore,
  CubeHome,
  CubeWorkspace,
  HistoryStore,
  ModelManager,
  RunnableConfigSchema,
  PermissionsSchema,
  INHERIT_MODEL,
  createBootstrap,
  type HomeManager,
  type WorkspacePermission,
  type GatewayId,
} from "@cube/workspace";
import { CubeRuntime } from "./runtime.js";
import { slashCommandSuggestions, type SlashCommandContext } from "./slash-commands.js";
import { MemoryService } from "./services/memory.service.js";
import {
  AnthropicAuthManager,
  GoogleAuthManager,
  GrokAuthManager,
  OpenAIAuthManager,
} from "./auth/auth-manager.js";
import { GatewayService, type GatewayServiceDependencies } from "./services/gateway.service.js";
import { ModelService } from "./services/model.service.js";
import { PreferenceService } from "./services/preference.service.js";
import { PermissionService } from "./services/permission.service.js";
import { McpService } from "./services/mcp.service.js";
import { PromptService } from "./services/prompt.service.js";
import { ThreadService } from "./services/thread.service.js";
import { BackgroundService } from "./services/background.service.js";
import { SubagentService } from "./services/subagent.service.js";
import type {
  GatewayReadiness,
  ModelSelection,
  PreferenceState,
  SlashCommandSuggestion,
} from "./types.js";
import { toRuntimeNotice } from "./types.js";

export type CreateCubeRuntimeOptions = {
  workspacePath?: string;
  home?: HomeManager;
  fetch?: typeof globalThis.fetch;
};

export type CubeBootstrap = {
  home: HomeManager;
  workspaceRoot: string;
  history: string[];
  preference: PreferenceState;
  suggestions: SlashCommandSuggestion[];
  readiness: GatewayReadiness;
  permission: WorkspacePermission | undefined;
  setTrust(trusted: boolean): Promise<void>;
  gateway: Pick<
    GatewayService,
    | "readiness"
    | "listChoices"
    | "listModels"
    | "createStoredDraft"
    | "createApiKeyDraft"
    | "createLocalDraft"
    | "beginOpenAILogin"
    | "beginGrokLogin"
    | "beginAnthropicLogin"
    | "beginGoogleLogin"
    | "discardDraft"
    | "commitInitial"
    | "removeCredential"
  >;
  start(): Promise<CubeRuntime>;
};

const normalizeStartupSession = async (session: Session): Promise<void> => {
  const boundId = session.thread.getId();
  if (!boundId) return;
  const bound = await session.thread.getById({ threadId: boundId });
  if (bound?.metadata?.cubeSubagent) {
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
    return;
  }
  const activeMessages = await session.thread.listActiveMessages({ limit: 1 });
  if (activeMessages.length > 0) {
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
    return;
  }
  await session.thread.delete({ threadId: boundId });
};

export const prepareCubeRuntime = async (
  options: CreateCubeRuntimeOptions = {},
): Promise<CubeBootstrap> => {
  const home = options.home ?? CubeHome();
  const workspacePath = options.workspacePath || process.env.INIT_CWD || process.cwd();
  await createBootstrap(home).run();
  const workspace = CubeWorkspace(home, workspacePath);
  const workspacePaths = await workspace.getPaths();
  const permission = await workspace.getPermission();
  const configStore = ConfigStore(home);
  const config = await configStore.read().catch((cause) => {
    throw new Error("Invalid config.yaml. Check its contents and file permissions, then retry.", {
      cause,
    });
  });
  const authStore = new AuthStore(home);
  const modelManager = new ModelManager(home);
  const openAIAuth = new OpenAIAuthManager(authStore);
  const grokAuth = new GrokAuthManager(authStore, { fetch: options.fetch });
  const anthropicAuth = new AnthropicAuthManager(authStore, { fetch: options.fetch });
  const googleAuth = new GoogleAuthManager(authStore, { fetch: options.fetch });
  const gatewayDependencies: GatewayServiceDependencies = {
    config: configStore,
    auth: authStore,
    adapters: new Map(),
    catalog: modelManager,
    mutationKey: home.getAuthPath(),
    openAIAuth,
    grokAuth,
    anthropicAuth,
    googleAuth,
    fetch: options.fetch,
  };
  const gateway = new GatewayService(gatewayDependencies);
  const startup: CubeBootstrap = {
    home,
    workspaceRoot: workspacePaths.root,
    history: (await HistoryStore(home).read()).map((entry) => entry.text),
    preference: {
      theme: config.theme,
      appTitle: [...config.app_title],
      statusLine: [...config.status_line],
    },
    suggestions: slashCommandSuggestions,
    permission,
    readiness: permission?.trusted
      ? await gateway.readiness()
      : { ready: false, reason: "Workspace is not trusted." },
    setTrust: async (trusted) => {
      await workspace.setTrust(trusted);
      startup.permission = await workspace.getPermission();
      startup.readiness = trusted
        ? await gateway.readiness()
        : { ready: false, reason: "Workspace is not trusted." };
    },
    gateway,
    start: async () => {
      const permission = await workspace.getPermission();
      if (!permission?.trusted) throw new Error("Workspace is not trusted.");
      startup.readiness = await gateway.readiness();
      if (!startup.readiness.ready) throw new Error(startup.readiness.reason);
      const config = RunnableConfigSchema.parse(await configStore.read());
      config.permissions = PermissionsSchema.parse(permission.permissions);
      startup.preference = {
        theme: config.theme,
        appTitle: [...config.app_title],
        statusLine: [...config.status_line],
      };
      let composition: CubeMastraComposition | undefined;
      let subagents: SubagentService | undefined;
      try {
        const gateways = createCubeGateways({
          auth: authStore,
          oauth: {
            openai: openAIAuth,
            xai: grokAuth,
            anthropic: anthropicAuth,
            google: googleAuth,
          },
          gatewayOptions: config.gateway_options,
          fetch: options.fetch,
        });
        gatewayDependencies.adapters = gateways.byGatewayId;
        composition = await createCubeMastra(home, workspace, config, {
          gateways,
        });
        const session = await composition.controller.createSession({
          resourceId: workspacePaths.root,
        });

        const memory = new MemoryService(session, composition.context);
        let mcp: McpService | undefined;
        let shuttingDown = false;
        const permissions = new PermissionService(workspace, config.permissions, {
          listTools: async () => [...(await composition!.agent.listPermissionTools()), "ask_user"],
          listMcpTools: () => composition!.mcp.readToolNames(),
          isBusy: () =>
            memory.isBusy() ||
            session.run.isRunning() ||
            session.approval.isArmed() ||
            session.suspensions.hasPending() ||
            !!mcp?.isApplying(),
          apply: async (next) => {
            const notices = await configureCubePermissions(
              session,
              next,
              composition!.mcp.readToolNames(),
            );
            Object.assign(config.permissions, next);
            composition!.tools.discardPreview();
            composition!.agent.refreshPermissions();
            await subagents?.refreshPermissions();
            for (const message of notices) session.emit({ type: "info", message });
          },
        });
        gatewayDependencies.onActiveCredentialRemoved = async () => {
          while (session.followUps.dequeue()) {
            /* Drop prompts queued for the removed credential. */
          }
          if (memory.isManual()) {
            memory.cancel();
            return;
          }
          await session.abort();
        };
        const permissionNotices = await configureCubePermissions(session, config.permissions);
        await normalizeStartupSession(session);
        mcp = new McpService({
          store: McpStore(home),
          client: composition.mcp,
          isBusy: () =>
            shuttingDown ||
            memory.isBusy() ||
            permissions.isApplying() ||
            session.run.isRunning() ||
            session.approval.isArmed() ||
            session.suspensions.hasPending() ||
            !!subagents?.isBusy(),
          beforePublish: async (names) => {
            const previousMcp = new Set(composition!.mcp.readToolNames());
            const native = (await composition!.agent.listPermissionTools()).filter(
              (name) => !previousMcp.has(name),
            );
            const collision = names.find((name) => name === "ask_user" || native.includes(name));
            if (collision) throw new Error(`MCP tool name collision: ${collision}`);
            await configureCubePermissions(session, config.permissions, names);
            composition!.context.invalidate();
          },
        });
        await mcp.reload();

        let runtime!: CubeRuntime;
        const background = new BackgroundService({
          history: () => composition!.mastra.getStorage()!.getStore("backgroundTasks"),
          processes: composition.tools.processes,
          workspaceRoot: workspacePaths.root,
          currentThread: () => session.thread.getId(),
          notice: (message) =>
            runtime ? runtime.notify(message) : permissionNotices.push(message),
          redact: composition.redact,
          drain: composition.drain,
          continueProcess: composition.continueProcess,
          delegationConfig: config.subagents,
        });
        composition.tools.setTaskHandler(async (input, threadId) => {
          if (input.action === "list") return { tasks: await background.list(threadId) };
          if (input.action === "kill") await background.stop(input, threadId);
          return background.get(input, threadId);
        });
        composition.tools.setSubagentHandler(async (input, threadId) => {
          const owner = { projectRoot: workspacePaths.root, parentThreadId: threadId };
          if (input.action === "list") return { subagents: await subagents!.list(owner) };
          if (input.action === "kill") return subagents!.interrupt(owner, input.id);
          return subagents!.get(owner, { ...input, view: input.view ?? "status" });
        });

        const thread = new ThreadService(
          session,
          {
            read: composition.agent.readInstructions,
            install: composition.agent.installInstructions,
            refresh: composition.agent.refreshInstructions,
            reload: async (includeDiscovered) => {
              if (includeDiscovered === true) await composition!.memoryRetrieval.reload();
              await reloadCubeAgentInstructions(composition!.agent, home, workspace, includeDiscovered);
            },
          },
          undefined,
          {
            fork: (id, title) => composition!.context.fork(id, title),
            invalidate: () => composition!.context.invalidate(),
            isBusy: () => memory.isBusy() || permissions.isApplying() || !!mcp?.isApplying(),
            drain: () => composition!.drain(),
            onActivated: () => composition!.durableMemory.check(),
            beforeDelete: async (threadId) => {
              await subagents?.beforeDelete(threadId);
              await background.beforeDelete(threadId);
            },
          },
        );
        const stopThreadEnd = session.onBeforeAgentEnd(async (event) => {
          try {
            await thread.finishRun(event.reason);
            const threadId = session.thread.getId();
            if (
              event.reason === "complete" &&
              threadId &&
              !session.approval.isArmed() &&
              !session.suspensions.hasPending()
            ) {
              await composition!.context.prune(threadId);
            }
          } catch (error) {
            composition!.logger.error("Thread finalization failed", {
              threadId: session.thread.getId(),
              error,
            });
            session.emit({ type: "info", message: toRuntimeNotice(error).message });
          }
        });
        composition.agent.onInstructionsDiscovered = async (snapshot) => {
          if (thread.current()) await thread.saveInstructions(snapshot);
        };
        let model!: ModelService;
        let liveModelId = toMastraRouterId(config.gateway, config.model);
        let liveEffort = config.model_config.reasoning_effort;
        const applyLiveModel = (modelId: string, selection: ModelSelection) => {
          // Rollback of a rejected switch is a no-op, even during an active turn.
          if (modelId === liveModelId && selection.reasoningEffort === liveEffort) return;
          if (
            memory.isBusy() ||
            permissions.isApplying() ||
            mcp?.isApplying() ||
            session.run.isRunning() ||
            session.approval.isArmed() ||
            session.suspensions.hasPending()
          ) {
            throw new Error(
              "Finish or cancel the current turn before changing the model or gateway.",
            );
          }
          updateCubeAgentModel(composition!.agent, modelId, selection.reasoningEffort);
          liveModelId = modelId;
          liveEffort = selection.reasoningEffort;
        };
        gatewayDependencies.applyLiveSelection = (gatewayId, selection) => {
          applyLiveModel(toMastraRouterId(gatewayId, selection.modelId), selection);
          model.adopt(selection);
        };
        model = new ModelService(
          home,
          session,
          {
            modelId: config.model,
            reasoningEffort: config.model_config.reasoning_effort,
          },
          async (selection) => {
            const current = RunnableConfigSchema.parse(await configStore.read());
            applyLiveModel(toMastraRouterId(current.gateway, selection.modelId), selection);
          },
          gateway,
        );
        subagents = new SubagentService({
          home,
          projectRoot: workspacePaths.root,
          config,
          storage: async () => {
            const store = await composition!.mastra.getStorage()!.getStore("memory");
            if (!store) throw new Error("Subagent storage is unavailable");
            return store;
          },
          background,
          createExecution: composition.subagents.prepare,
          publishCatalog: composition.subagents.setDefinitions,
          readParent: async (id) => {
            if (session.thread.getId() !== id)
              throw new Error("Delegation requires the active parent");
            return {
              modelId: liveModelId,
              reasoningEffort: liveEffort,
              instructions: composition!.agent.readInstructions(),
            };
          },
          resolveModel: async (definition, parent) => {
            const selected = definition.model ?? config.subagents.model;
            const canonical = getCanonicalModelId(
              selected === INHERIT_MODEL ? parent.modelId : selected,
            );
            const provider = canonical.split("/")[0];
            const group = parent.modelId.split("/")[0];
            const route = (
              Object.entries(gatewayDescriptors) as [
                GatewayId,
                { internalId: string; providerId: string },
              ][]
            ).find(
              ([, descriptor]) =>
                descriptor.internalId === group && descriptor.providerId === provider,
            )?.[0];
            if (!route) throw new Error(`Unavailable child gateway for model: ${canonical}`);
            const catalog = await gateway.listModels(route);
            const found = Object.values(catalog.providers)
              .flatMap((provider) => provider.models)
              .find((candidate) => candidate.modelId === canonical);
            if (!found) throw new Error(`Unavailable child model: ${canonical}`);
            const explicit = definition.reasoning_effort ?? config.subagents.reasoning_effort;
            const supported = (effort: string) =>
              effort === "none" ||
              (found.reasoning !== false && found.reasoning_efforts?.includes(effort));
            if (explicit && !supported(explicit))
              throw new Error(`Unsupported child reasoning effort: ${explicit}`);
            return {
              modelId: toMastraRouterId(route, canonical),
              reasoningEffort:
                explicit ??
                (parent.reasoningEffort && supported(parent.reasoningEffort)
                  ? parent.reasoningEffort
                  : undefined),
            };
          },
          toolNames: () => composition!.agent.listPermissionTools(),
          deliver: composition.deliverSubagentResult,
          currentThread: () => session.thread.getId(),
          redact: composition.redact,
          notice: (text) => (runtime ? runtime.notify(text) : permissionNotices.push(text)),
        });
        await subagents.reloadCatalog();
        composition.subagents.setDispatch(request => subagents!.dispatch(request));
        const preference = new PreferenceService(
          home,
          {
            theme: config.theme,
            appTitle: config.app_title,
            statusLine: config.status_line,
          },
          composition.skills,
        );
        const commands: SlashCommandContext = {
          thread,
          model,
          preference,
          permission: permissions,
          memory,
          gateway,
          prompt: { initialize: () => prompt.initialize() },
          mcp,
          subagents,
        };
        const prompt = new PromptService(home, session, thread, commands, (callback) => {
          const threadId = session.thread.getId();
          return runWithCubeLogContext(threadId ? { threadId } : {}, callback);
        });

        runtime = new CubeRuntime({
          session,
          tools: composition.tools,
          context: composition.context,
          notices: permissionNotices,
          background,
          subagents,
          mcp,
          prompt,
          thread,
          model,
          preference,
          permission: permissions,
          memory,
          gateway,
          suggestions: slashCommandSuggestions,
          workspaceRoot: workspacePaths.root,
          readInstructionInfo: () => composition!.agent.instructionInfo,
          readHistory: async () => (await HistoryStore(home).read()).map((entry) => entry.text),
          shutdownResources: async () => {
            shuttingDown = true;
            stopThreadEnd();
            await subagents?.shutdown();
            await mcp?.dispose();
            await composition!.shutdown();
          },
        });
        composition.setMemoryNotice((message) => runtime.notify(message));
        composition.memoryRetrieval.check();
        composition.durableMemory.check();
        return runtime;
      } catch (error) {
        await subagents?.shutdown().catch(() => undefined);
        await composition?.shutdown().catch(() => undefined);
        throw error;
      }
    },
  };
  return startup;
};

export const createCubeRuntime = async (
  options: CreateCubeRuntimeOptions = {},
): Promise<CubeRuntime> => (await prepareCubeRuntime(options)).start();
