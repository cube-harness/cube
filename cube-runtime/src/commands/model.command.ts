import type { Home, ReasoningEffort } from "@cube/workspace";
import { ConfigStore, ModelManager } from "@cube/workspace";
import type { CommandHandler } from "../command-manager.js";
import type { ActionDispatcher } from "../dispatcher.js";
import type { ProviderGroup } from "../contracts/ui.contract.js";

export interface ModelCommandDependencies {
  home: Home;
  dispatcher: ActionDispatcher;
  isTurnActive?: () => boolean;
  onModelSelected?: (modelId: string, reasoningEffort?: string) => Promise<void> | void;
}

export const createModelCommand = (
  dependencies: ModelCommandDependencies,
): CommandHandler => async (rawArgument: string) => {
  if (dependencies.isTurnActive?.()) {
    dependencies.dispatcher.emit({
      type: "system:message",
      content: "Cannot open model picker while an agent turn is active.",
    });
    return;
  }

  const config = await ConfigStore(dependencies.home).read().catch(() => null);
  const currentModelId = config?.model || "";
  const currentReasoningEffort = config?.model_config?.reasoning_effort as ReasoningEffort | undefined;

  const argument = rawArgument.trim();
  if (argument) {
    await ConfigStore(dependencies.home).update((current) => ({
      ...current,
      model: argument,
    }));
    dependencies.dispatcher.emit({
      type: "state:info",
      info: { model: argument },
    });
    dependencies.dispatcher.emit({
      type: "system:message",
      content: `Changed model to: ${argument}`,
    });
    if (dependencies.onModelSelected) {
      await dependencies.onModelSelected(argument);
    }
    return;
  }

  dependencies.dispatcher.emit({
    type: "activity:start",
    id: "model-discovery",
    message: "Discovering models from active providers...",
  });

  const modelManager = new ModelManager(dependencies.home);
  let catalog: Awaited<ReturnType<typeof modelManager.getCatalog>> | null = null;
  try {
    catalog = await modelManager.getCatalog();
  } finally {
    dependencies.dispatcher.emit({ type: "activity:end", id: "model-discovery" });
  }

  const providersEntries = Object.entries(catalog?.providers || {});
  if (providersEntries.length === 0) {
    dependencies.dispatcher.emit({
      type: "system:message",
      content:
        "No active AI providers found. Please configure API keys in .env or configure Ollama in config.yaml.",
    });
    return;
  }

  const providers: ProviderGroup[] = providersEntries.map(([id, group]) => ({
    id,
    name: group.name,
    models: group.models,
  }));

  // Emit dialog:model_picker event for UI to render
  dependencies.dispatcher.emit({
    type: "dialog:model_picker",
    providers,
    currentModelId,
    currentReasoningEffort,
  });
};
