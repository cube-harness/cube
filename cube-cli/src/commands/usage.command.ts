import type { Home } from "@cube/workspace";
import { ConfigStore, ModelManager } from "@cube/workspace";
import type { Session } from "@cube/agent";
import { renderUsageBoxToString } from "@cube/tui";
import type { CommandHandler } from "../command-manager.js";

export interface UsageCommandDependencies {
  home: Home;
  session: Session;
  showMessage: (message: string) => void;
}

export const createUsageCommandHandler = (
  deps: UsageCommandDependencies,
): CommandHandler => async () => {
  const config = await ConfigStore(deps.home).read().catch(() => null);
  const activeModelId = config?.model || "unknown";
  const reasoningEffort = config?.model_config?.reasoning_effort;

  const modelManager = new ModelManager(deps.home);
  const catalog = await modelManager.getCatalog().catch(() => null);
  const foundModel = catalog?.models?.find((m) => m.modelId === activeModelId);

  const capabilities: string[] = [];
  if (foundModel?.tool_call) capabilities.push("tools");
  if (foundModel?.reasoning) capabilities.push("reasoning");
  if (foundModel?.attachment) capabilities.push("vision");

  const contextLimit = foundModel?.limit?.context ?? 128_000;
  const maxOutput = foundModel?.limit?.output;

  const usage = (deps.session.getTokenUsage?.() ?? {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
  }) as {
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

  const activeTurnTokens =
    usage.raw?.inputTokens?.total ??
    usage.raw?.raw?.promptTokenCount;

  const activeThreadId = deps.session.thread.getId();
  let threadTitle: string | undefined;

  if (activeThreadId) {
    try {
      const threads = await deps.session.thread.list();
      const currentThread = threads?.find(
        (t: { id: string; title?: string }) => t.id === activeThreadId,
      );
      threadTitle = currentThread?.title;
    } catch {
      // ignore thread list errors
    }
  }

  const output = renderUsageBoxToString({
    model: activeModelId,
    reasoningEffort,
    capabilities,
    contextLimit,
    maxOutput,
    activeTurnTokens,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedTokens: usage.cachedInputTokens ?? 0,
    cacheCreationTokens: usage.cacheCreationInputTokens ?? 0,
    totalTokens: usage.totalTokens,
    threadTitle,
    threadId: activeThreadId ?? "new thread",
  });

  deps.showMessage(output);
};
