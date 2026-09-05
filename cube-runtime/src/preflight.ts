import {
  AuthStore,
  ConfigStore,
  CubeHome,
  CubeWorkspace,
  HistoryStore,
  ModelManager,
  Store,
  createBootstrap,
  migrateConfig,
  type HomeManager,
} from "@cube/workspace";
import { OpenAIAuthManager } from "./auth/auth-manager.js";
import { createCubeRuntime, type CreateCubeRuntimeOptions } from "./bootstrap.js";
import type { CubeRuntime } from "./runtime.js";
import { GatewayService } from "./services/gateway.service.js";
import type { GatewayReadiness, PreferenceState } from "./types.js";

export type PrepareCubeRuntimeOptions = CreateCubeRuntimeOptions & {
  fetch?: typeof globalThis.fetch;
};

export type CubePreflight = {
  home: HomeManager;
  workspaceRoot: string;
  history: string[];
  preference: PreferenceState;
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
    | "discardDraft"
    | "commitInitial"
  >;
  start(): Promise<CubeRuntime>;
};

export const prepareCubeRuntime = async (
  options: PrepareCubeRuntimeOptions = {},
): Promise<CubePreflight> => {
  const home = options.home ?? CubeHome();
  const workspacePath = options.workspacePath || process.env.INIT_CWD || process.cwd();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  await createBootstrap(home).run();

  const authStore = new AuthStore(home);
  const rawConfig = await new Store<unknown>(home.getConfigPath(), "yaml").read();
  const auth = await authStore.read();
  const migrated = await migrateConfig(rawConfig, {
    hasApiKey: (provider) => Boolean(auth.api_keys[provider]),
    hasOpenAISubscription: Boolean(auth.subscriptions.openai),
    localReachable: async (provider, baseUrl) => {
      const url = provider === "ollama"
        ? `${baseUrl}/api/tags`
        : `${baseUrl}/models`;
      try {
        return (await fetchImpl(url, { signal: AbortSignal.timeout(5_000) })).ok;
      } catch {
        return false;
      }
    },
  });
  if ((rawConfig as { version?: unknown }).version === 1) {
    await ConfigStore(home).write(migrated.config);
  }

  const configStore = ConfigStore(home);
  const config = await configStore.read();
  const modelManager = new ModelManager(home);
  const gateway = new GatewayService({
    config: configStore,
    auth: authStore,
    adapters: new Map(),
    catalog: modelManager,
    openAIAuth: new OpenAIAuthManager(authStore),
    fetch: fetchImpl,
  });
  const workspaceRoot = (await CubeWorkspace(home, workspacePath).getPaths()).root;

  return {
    home,
    workspaceRoot,
    history: (await HistoryStore(home).read()).map((entry) => entry.text),
    preference: {
      theme: config.theme,
      appTitle: [...config.app_title],
      statusLine: [...config.status_line],
    },
    readiness: await gateway.readiness(),
    gateway,
    start: async () => {
      const readiness = await gateway.readiness();
      if (!readiness.ready) throw new Error(readiness.reason);
      return createCubeRuntime(options);
    },
  };
};
