import {
  createCubeMastra,
  configureCubePermissions,
  finalizeCubeAgentMemory,
  reloadCubeAgentSoul,
  runWithCubeLogContext,
  updateCubeAgentModel,
  type CubeMastraComposition,
  type Session,
} from "@cube/agent";
import {
  ConfigStore,
  CubeHome,
  HistoryStore,
  Workspace,
  createBootstrap,
  type Home,
} from "@cube/workspace";
import { CubeRuntime } from "./runtime.js";
import {
  slashCommandSuggestions,
  type SlashCommandContext,
} from "./slash-commands.js";
import { MemoryService } from "./services/memory.service.js";
import { ModelService } from "./services/model.service.js";
import { PreferenceService } from "./services/preference.service.js";
import { PromptService } from "./services/prompt.service.js";
import { ThreadService } from "./services/thread.service.js";

export type CreateCubeRuntimeOptions = {
  workspacePath?: string;
  home?: Home;
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
  const workspacePath =
    options.workspacePath || process.env.INIT_CWD || process.cwd();
  let composition: CubeMastraComposition | undefined;

  try {
    await home.ensure();
    await createBootstrap(home).run();
    const workspace = Workspace(home, workspacePath);
    const workspacePaths = await workspace.getPaths();
    const config = await ConfigStore(home).read();
    composition = await createCubeMastra(home, workspace, config);
    const session = await composition.controller.createSession({
      resourceId: workspacePaths.root,
    });

    await configureCubePermissions(session, config.permissions);
    await normalizeStartupSession(session);

    const thread = new ThreadService(session, async () => {
      await reloadCubeAgentSoul(composition!.agent, home);
    });
    const model = new ModelService(
      home,
      session,
      {
        modelId: config.model,
        reasoningEffort: config.model_config.reasoning_effort,
      },
      (selection) =>
        updateCubeAgentModel(
          composition!.agent,
          selection.modelId,
          selection.reasoningEffort,
        ),
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
    };
    const prompt = new PromptService(
      home,
      session,
      thread,
      commands,
      (callback) => {
        const threadId = session.thread.getId();
        return runWithCubeLogContext(threadId ? { threadId } : {}, callback);
      },
    );

    return new CubeRuntime({
      session,
      prompt,
      thread,
      model,
      preference,
      memory,
      suggestions: slashCommandSuggestions,
      workspaceRoot: workspacePaths.root,
      readHistory: async () =>
        (await HistoryStore(home).read()).map((entry) => entry.text),
      shutdownResources: () => composition!.shutdown(),
    });
  } catch (error) {
    await composition?.shutdown().catch(() => undefined);
    throw error;
  }
};
