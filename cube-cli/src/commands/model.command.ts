import type { Home } from "@cube/workspace";
import { ConfigStore, ModelManager } from "@cube/workspace";
import type { TuiApp, ProviderGroup, ReasoningEffort } from "@cube/tui";
import type { CommandHandler } from "../command-manager.js";

export interface ModelCommandDependencies {
  home: Home;
  getApp: () => TuiApp | undefined;
  showMessage: (message: string) => void;
  isTurnActive?: () => boolean;
  onModelSelected?: (modelId: string, reasoningEffort?: string) => Promise<void> | void;
}

export const createModelCommandHandler = (
  dependencies: ModelCommandDependencies,
): CommandHandler => async (rawArgument: string) => {
  if (dependencies.isTurnActive?.()) {
    dependencies.showMessage("Cannot open model picker while an agent turn is active.");
    return;
  }

  const app = dependencies.getApp();
  if (!app) {
    dependencies.showMessage("Cube TUI is not ready.");
    return;
  }

  const config = await ConfigStore(dependencies.home).read().catch(() => null);
  const currentModelId = config?.model || "";
  const currentReasoningEffort = config?.model_config?.reasoning_effort;

  const argument = rawArgument.trim();
  if (argument) {
    await ConfigStore(dependencies.home).update((current) => ({
      ...current,
      model: argument,
    }));
    app.setInfo({ model: argument });
    dependencies.showMessage(`Changed model to: ${argument}`);
    if (dependencies.onModelSelected) {
      await dependencies.onModelSelected(argument);
    }
    return;
  }

  app.startLoading("Discovering models from active providers...");
  const modelManager = new ModelManager(dependencies.home);
  let catalogProviders: Awaited<ReturnType<typeof modelManager.getProvidersWithModels>> = [];
  try {
    catalogProviders = await modelManager.getProvidersWithModels();
  } finally {
    app.stopLoading();
  }

  if (!catalogProviders || catalogProviders.length === 0) {
    dependencies.showMessage(
      "No active AI providers found. Please configure API keys in .env or configure Ollama in config.yaml.",
    );
    return;
  }

  const providers: ProviderGroup[] = catalogProviders.map((p) => ({
    id: p.id,
    name: p.name,
    models: p.models.map((m) => ({
      modelId: m.modelId,
      name: m.name,
      provider: m.provider,
      family: m.family,
      reasoning: m.reasoning,
      tool_call: m.tool_call,
      attachment: m.attachment,
      limit: m.limit,
    })),
  }));

  const result = await app.openModelPicker({
    providers,
    currentModelId,
    currentReasoningEffort: currentReasoningEffort as ReasoningEffort,
  });

  if (!result) return;

  const { modelId, reasoningEffort } = result;

  // 1. Persist model and reasoning_effort to config.yaml
  await ConfigStore(dependencies.home).update((current) => ({
    ...current,
    model: modelId,
    model_config: {
      ...current.model_config,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    },
  }));

  // 2. Update TUI InfoBox
  const modelDisplay = `${modelId}${
    reasoningEffort && reasoningEffort !== "none" ? ` (${reasoningEffort})` : ""
  }`;
  app.setInfo({ model: modelDisplay });

  // 3. Show confirmation in chat
  const effortStr =
    reasoningEffort && reasoningEffort !== "none"
      ? ` [effort: ${reasoningEffort}]`
      : "";
  dependencies.showMessage(`Model set to: ${modelId}${effortStr}`);

  // 4. Trigger callback
  if (dependencies.onModelSelected) {
    await dependencies.onModelSelected(modelId, reasoningEffort);
  }
};
