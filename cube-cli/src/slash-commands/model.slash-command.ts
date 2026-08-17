import type {
  ModelCatalogEntry,
  ModelCatalogResult,
  ModelSelection,
  PreparedModelSelection,
  SelectionValidationResult,
} from "@cube/agent";
import type {
  ModelCatalogView,
  OpenModelPickerOptions,
  TuiModelSelection,
} from "@cube/tui";
import type { SlashCommandHandler } from "./registry.js";

export interface ModelCommandDependencies {
  getCurrentSelection: () => ModelSelection;
  getPersistedSelection: () => ModelSelection;
  loadCatalog: (signal: AbortSignal) => Promise<ModelCatalogResult>;
  openModelPicker: (
    options: OpenModelPickerOptions,
  ) => Promise<TuiModelSelection | null>;
  prepareSelection: (
    selection: ModelSelection,
    entry: ModelCatalogEntry | null,
  ) => SelectionValidationResult;
  applySelection: (prepared: PreparedModelSelection) => Promise<void>;
  persistSelection: (selection: ModelSelection) => void;
  showMessage: (message: string) => void;
}

const toModelCatalogView = (
  catalog: ModelCatalogResult,
): ModelCatalogView => ({
  models: catalog.models.map((entry) => ({
    id: entry.id,
    ...(entry.config.reasoningEffort
      ? { reasoningEfforts: [...entry.config.reasoningEffort.values] }
      : {}),
  })),
  warnings: [...catalog.warnings],
});

export const createModelCommandHandler = (
  dependencies: ModelCommandDependencies,
): SlashCommandHandler => async (rawArgument) => {
  const argument = rawArgument.trim();
  const current = dependencies.getCurrentSelection();
  const previousPersisted = dependencies.getPersistedSelection();
  let loadedCatalog: ModelCatalogResult | undefined;
  const candidate = await dependencies.openModelPicker({
    currentSelection: current,
    ...(argument ? { requestedModelId: argument } : {}),
    loadModels: async (signal) => {
      loadedCatalog = await dependencies.loadCatalog(signal);
      return toModelCatalogView(loadedCatalog);
    },
  });
  if (!candidate) return;

  const entry = loadedCatalog?.models.find(({ id }) => id === candidate.modelId);
  if (!entry) {
    throw new Error(`Selected model is unavailable: ${candidate.modelId}`);
  }

  const requestedEffort = candidate.config.reasoning_effort;
  const reasoningEffort = requestedEffort
    ? entry.config.reasoningEffort?.values.find((value) => value === requestedEffort)
    : undefined;
  if (requestedEffort && !reasoningEffort) {
    throw new Error(`Unsupported reasoning effort returned by TUI: ${requestedEffort}`);
  }

  const selection: ModelSelection = {
    modelId: candidate.modelId,
    config: reasoningEffort ? { reasoning_effort: reasoningEffort } : {},
  };
  const validated = dependencies.prepareSelection(selection, entry);
  validated.warnings.forEach(dependencies.showMessage);

  dependencies.persistSelection(validated.prepared.selection);
  try {
    await dependencies.applySelection(validated.prepared);
  } catch (applyError) {
    try {
      dependencies.persistSelection(previousPersisted);
    } catch (rollbackError) {
      throw new AggregateError(
        [applyError, rollbackError],
        "Model apply failed and config rollback also failed.",
      );
    }
    throw applyError;
  }

  const effort = validated.prepared.selection.config.reasoning_effort;
  dependencies.showMessage(
    `Model changed to ${validated.prepared.selection.modelId}${
      effort ? ` (reasoning: ${effort})` : ""
    }.`,
  );
};
