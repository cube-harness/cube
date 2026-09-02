import type { Session } from "@cube/agent";
import {
  ConfigStore,
  ModelManager,
  type Home,
  type ModelCatalog,
} from "@cube/workspace";
import type {
  ModelSelection,
  ModelState,
  UsageMetrics,
} from "../types.js";

type CatalogReader = Pick<ModelManager, "getCatalog">;

type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
  raw?: {
    inputTokens?: { total?: number };
    raw?: { promptTokenCount?: number };
  };
};

const copyState = (state: ModelState): ModelState => ({ ...state });

export class ModelService {
  constructor(
    private readonly home: Home,
    private readonly session: Session,
    private state: ModelState,
    private readonly applyLiveModel: (selection: ModelSelection) => void,
    private readonly catalog: CatalogReader = new ModelManager(home),
  ) {
    this.state = copyState(state);
  }

  list(): Promise<ModelCatalog> {
    return this.catalog.getCatalog();
  }

  current(): ModelState {
    return copyState(this.state);
  }

  async set(selection: ModelSelection): Promise<ModelState> {
    const catalog = await this.list();
    const model = Object.values(catalog.providers)
      .flatMap((provider) => provider.models)
      .find((candidate) => candidate.modelId === selection.modelId);

    if (!model) {
      throw new Error(`Unknown model: ${selection.modelId}`);
    }

    const effort = selection.reasoningEffort;
    if (effort && effort !== "none") {
      if (!model.reasoning) {
        throw new Error(`Model ${selection.modelId} does not support reasoning`);
      }
      if (model.reasoning_efforts && !model.reasoning_efforts.includes(effort)) {
        throw new Error(
          `Model ${selection.modelId} does not support reasoning effort: ${effort}`,
        );
      }
    }

    await ConfigStore(this.home).update((config) => {
      const modelConfig = { ...config.model_config };
      if (effort && effort !== "none") {
        modelConfig.reasoning_effort = effort;
      } else {
        delete modelConfig.reasoning_effort;
      }
      return {
        ...config,
        model: selection.modelId,
        model_config: modelConfig,
      };
    });

    this.applyLiveModel(copyState(selection));
    this.state = {
      modelId: selection.modelId,
      ...(effort && effort !== "none" ? { reasoningEffort: effort } : {}),
    };
    return this.current();
  }

  async getUsage(): Promise<UsageMetrics> {
    const catalog = await this.list().catch(() => null);
    const model = catalog
      ? Object.values(catalog.providers)
          .flatMap((provider) => provider.models)
          .find((candidate) => candidate.modelId === this.state.modelId)
      : undefined;
    const capabilities: string[] = [];
    if (model?.tool_call) capabilities.push("tools");
    if (model?.reasoning) capabilities.push("reasoning");
    if (model?.attachment) capabilities.push("vision");

    const usage = (this.session.getTokenUsage?.() ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
    }) as TokenUsage;
    const threadId = this.session.thread.getId();
    let threadTitle: string | undefined;

    if (threadId) {
      try {
        const threads = await this.session.thread.list();
        threadTitle = threads.find((thread) => thread.id === threadId)?.title;
      } catch {
        // Usage remains available even when thread metadata cannot be loaded.
      }
    }

    const effectiveUsage = threadId ? usage : undefined;

    return {
      model: this.state.modelId,
      reasoningEffort: this.state.reasoningEffort,
      capabilities,
      directory: this.session.identity?.getResourceId?.(),
      sessionId: this.session.identity?.getId?.(),
      contextLimit: model?.limit.context ?? 128_000,
      maxOutput: model?.limit.output,
      activeTurnTokens:
        effectiveUsage?.raw?.inputTokens?.total ??
        effectiveUsage?.raw?.raw?.promptTokenCount ??
        0,
      promptTokens: effectiveUsage?.promptTokens ?? 0,
      completionTokens: effectiveUsage?.completionTokens ?? 0,
      reasoningTokens: effectiveUsage?.reasoningTokens ?? 0,
      cachedTokens: effectiveUsage?.cachedInputTokens ?? 0,
      cacheCreationTokens: effectiveUsage?.cacheCreationInputTokens ?? 0,
      totalTokens: effectiveUsage?.totalTokens ?? 0,
      threadTitle,
      threadId: threadId ?? "new thread",
    };
  }
}
