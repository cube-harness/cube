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
import { OpenAIAuthManager } from "./auth/auth-manager.js";
import { GatewayService } from "./services/gateway.service.js";
import { ModelService } from "./services/model.service.js";
import { PreferenceService } from "./services/preference.service.js";
import { PromptService } from "./services/prompt.service.js";
import { ThreadService } from "./services/thread.service.js";

export type CreateCubeRuntimeOptions = {
  workspacePath?: string;
  home?: HomeManager;
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

export const createCubeRuntime = async (
  options: CreateCubeRuntimeOptions = {},
): Promise<CubeRuntime> => {
  const home = options.home ?? CubeHome();
  const workspacePath = options.workspacePath || process.env.INIT_CWD || process.cwd();
  let composition: CubeMastraComposition | undefined;

  try {
    await home.ensure();
    await createBootstrap(home).run();
    const workspace = CubeWorkspace(home, workspacePath);
    const workspacePaths = await workspace.getPaths();
    const configStore = ConfigStore(home);
    const config = RunnableConfigSchema.parse(await configStore.read());
    const authStore = new AuthStore(home);
    const modelManager = new ModelManager(home);
    const canonicalCatalog = await modelManager.getCatalog();
    const openAIAuth = new OpenAIAuthManager(authStore);
    const gateways = createCubeGateways({
      auth: authStore,
      openAISubscription: openAIAuth,
      openAISubscriptionModelIds:
        canonicalCatalog.providers.openai?.models.map((model) => model.modelId) ?? [],
      gatewayOptions: config.gateway_options,
    });
    composition = await createCubeMastra(home, workspace, config, { gateways });
    const session = await composition.controller.createSession({
      resourceId: workspacePaths.root,
    });

    await configureCubePermissions(session, config.permissions);
    await normalizeStartupSession(session);

    const thread = new ThreadService(session, async () => {
      await reloadCubeAgentSoul(composition!.agent, home);
    });
    const gateway = new GatewayService({
      config: configStore,
      auth: authStore,
      adapters: gateways.byGatewayId,
      catalog: modelManager,
      openAIAuth,
      applyLiveSelection: (gatewayId, selection) =>
        updateCubeAgentModel(
          composition!.agent,
          toMastraRouterId(gatewayId, selection.modelId),
          selection.reasoningEffort,
        ),
    });
    const model = new ModelService(
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
};
