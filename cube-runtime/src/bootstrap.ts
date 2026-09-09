import {
  createCubeMastra,
  createCubeGateways,
  configureCubePermissions,
  finalizeCubeAgentMemory,
  reloadCubeAgentSoul,
  runWithCubeLogContext,
  updateCubeAgentModel,
  toMastraRouterId,
  type CubeMastraComposition,
  type Session,
} from "@cube/agent";
import {
  ConfigStore,
  AuthStore,
  CubeHome,
  CubeWorkspace,
  HistoryStore,
  ModelManager,
  RunnableConfigSchema,
  createBootstrap,
  type HomeManager,
} from "@cube/workspace";
import { CubeRuntime } from "./runtime.js";
import { slashCommandSuggestions, type SlashCommandContext } from "./slash-commands.js";
import { MemoryService } from "./services/memory.service.js";
import { AnthropicAuthManager, GrokAuthManager, OpenAIAuthManager } from "./auth/auth-manager.js";
import { GatewayService, type GatewayServiceDependencies } from "./services/gateway.service.js";
import { ModelService } from "./services/model.service.js";
import { PreferenceService } from "./services/preference.service.js";
import { PromptService } from "./services/prompt.service.js";
import { ThreadService } from "./services/thread.service.js";
import type { GatewayReadiness, PreferenceState, SlashCommandSuggestion } from "./types.js";

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
    | "discardDraft"
    | "commitInitial"
    | "removeCredential"
  >;
  start(): Promise<CubeRuntime>;
};

const normalizeStartupSession = async (session: Session): Promise<void> => {
  const boundId = session.thread.getId();
  if (!boundId) return;
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
  const gatewayDependencies: GatewayServiceDependencies = {
    config: configStore,
    auth: authStore,
    adapters: new Map(),
    catalog: modelManager,
    mutationKey: home.getAuthPath(),
    openAIAuth,
    grokAuth,
    anthropicAuth,
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
    readiness: await gateway.readiness(),
    gateway,
    start: async () => {
      startup.readiness = await gateway.readiness();
      if (!startup.readiness.ready) throw new Error(startup.readiness.reason);
      const config = RunnableConfigSchema.parse(await configStore.read());
      startup.preference = {
        theme: config.theme,
        appTitle: [...config.app_title],
        statusLine: [...config.status_line],
      };
      let composition: CubeMastraComposition | undefined;
      try {
        const gateways = createCubeGateways({
          auth: authStore,
          oauth: { openai: openAIAuth, xai: grokAuth, anthropic: anthropicAuth },
          gatewayOptions: config.gateway_options,
          fetch: options.fetch,
        });
        gatewayDependencies.adapters = gateways.byGatewayId;
        composition = await createCubeMastra(home, workspace, config, { gateways });
        const session = await composition.controller.createSession({
          resourceId: workspacePaths.root,
        });

        gatewayDependencies.onActiveCredentialRemoved = async () => {
          while (session.followUps.dequeue()) { /* Drop prompts queued for the removed credential. */ }
          await session.abort();
        };
        await configureCubePermissions(session, config.permissions);
        await normalizeStartupSession(session);

        const thread = new ThreadService(session, async () => {
          await reloadCubeAgentSoul(composition!.agent, home);
        });
        let model!: ModelService;
        gatewayDependencies.applyLiveSelection = (gatewayId, selection) => {
          updateCubeAgentModel(
            composition!.agent,
            toMastraRouterId(gatewayId, selection.modelId),
            selection.reasoningEffort,
          );
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
            updateCubeAgentModel(
              composition!.agent,
              toMastraRouterId(current.gateway, selection.modelId),
              selection.reasoningEffort,
            );
          },
          gateway,
        );
        const preference = new PreferenceService(home, {
          theme: config.theme,
          appTitle: config.app_title,
          statusLine: config.status_line,
        });
        const memory = new MemoryService(session, (input) =>
          finalizeCubeAgentMemory(composition!.agent, input),
        );
        const commands: SlashCommandContext = {
          thread,
          model,
          preference,
          memory,
          gateway,
        };
        const prompt = new PromptService(home, session, thread, commands, (callback) => {
          const threadId = session.thread.getId();
          return runWithCubeLogContext(threadId ? { threadId } : {}, callback);
        });

        return new CubeRuntime({
          session,
          prompt,
          thread,
          model,
          preference,
          memory,
          gateway,
          suggestions: slashCommandSuggestions,
          workspaceRoot: workspacePaths.root,
          readHistory: async () => (await HistoryStore(home).read()).map((entry) => entry.text),
          shutdownResources: () => composition!.shutdown(),
        });
      } catch (error) {
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
