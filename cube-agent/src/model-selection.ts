import type { ModelConfig } from "@cube/workspace";
import type { ModelCatalogEntry } from "./model-catalog.js";

export interface ModelSelection {
  modelId: string;
  config: ModelConfig;
}

export interface PreparedModelSelection {
  selection: ModelSelection;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface SelectionValidationResult {
  prepared: PreparedModelSelection;
  warnings: string[];
}

export interface ActiveModelSelection {
  get: () => PreparedModelSelection;
  set: (selection: PreparedModelSelection) => void;
}

export interface SessionModelControl {
  get: () => string;
  switch: (input: {
    modelId: string;
    scope: "global";
  }) => Promise<void>;
}

const mapProviderOptions = (
  selection: ModelSelection,
): Record<string, Record<string, unknown>> | undefined => {
  const effort = selection.config.reasoning_effort;
  if (!effort) return undefined;

  const provider = selection.modelId.split("/", 1)[0];
  switch (provider) {
    case "openai":
      return { openai: { reasoningEffort: effort } };
    case "google":
      return { google: { thinkingConfig: { thinkingLevel: effort } } };
    case "openrouter":
      return { openrouter: { reasoning: { effort } } };
    default:
      return undefined;
  }
};

export const prepareModelSelection = (
  selection: ModelSelection,
  catalogEntry: ModelCatalogEntry | null,
): SelectionValidationResult => {
  if (catalogEntry && catalogEntry.id !== selection.modelId) {
    throw new Error(
      `Catalog entry ${catalogEntry.id} does not match selection ${selection.modelId}.`,
    );
  }

  const effort = selection.config.reasoning_effort;
  if (!effort) {
    return {
      prepared: {
        selection: { modelId: selection.modelId, config: {} },
      },
      warnings: [],
    };
  }

  const supported = catalogEntry?.config.reasoningEffort?.values.includes(effort) ?? false;
  if (!supported) {
    return {
      prepared: {
        selection: { modelId: selection.modelId, config: {} },
      },
      warnings: [
        `Model ${selection.modelId} does not support reasoning effort ${effort}; the value was ignored.`,
      ],
    };
  }

  const normalized: ModelSelection = {
    modelId: selection.modelId,
    config: { reasoning_effort: effort },
  };
  const providerOptions = mapProviderOptions(normalized);
  return {
    prepared: {
      selection: normalized,
      ...(providerOptions ? { providerOptions } : {}),
    },
    warnings: [],
  };
};

export const createActiveModelSelection = (
  initial: PreparedModelSelection,
): ActiveModelSelection => {
  let current = structuredClone(initial);
  return {
    get: () => structuredClone(current),
    set: (selection) => {
      current = structuredClone(selection);
    },
  };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const resolveInitialModelSelection = async (
  selection: ModelSelection,
  findCatalogEntry: (
    modelId: string,
  ) => Promise<ModelCatalogEntry | null>,
): Promise<SelectionValidationResult> => {
  const effort = selection.config.reasoning_effort;
  if (!effort) return prepareModelSelection(selection, null);

  try {
    return prepareModelSelection(
      selection,
      await findCatalogEntry(selection.modelId),
    );
  } catch (error) {
    return {
      prepared: {
        selection: { modelId: selection.modelId, config: {} },
      },
      warnings: [
        `Unable to validate model config because ${errorMessage(error)}; reasoning effort ${effort} was ignored for this run.`,
      ],
    };
  }
};

export const createSessionModelSelection = (input: {
  active: ActiveModelSelection;
  sessionModel: SessionModelControl;
}) => {
  const getModelSelection = (): ModelSelection => input.active.get().selection;
  const applyModelSelection = async (
    prepared: PreparedModelSelection,
  ): Promise<void> => {
    const previousSessionModelId = input.sessionModel.get();
    try {
      await input.sessionModel.switch({
        modelId: prepared.selection.modelId,
        scope: "global",
      });
      input.active.set(prepared);
    } catch (applyError) {
      if (input.sessionModel.get() !== previousSessionModelId) {
        try {
          await input.sessionModel.switch({
            modelId: previousSessionModelId,
            scope: "global",
          });
        } catch (restoreError) {
          throw new AggregateError(
            [applyError, restoreError],
            "Model apply failed and session restoration also failed.",
          );
        }
      }
      throw applyError;
    }
  };

  return { getModelSelection, applyModelSelection };
};
