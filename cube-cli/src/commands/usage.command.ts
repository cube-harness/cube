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

  const modelManager = new ModelManager(deps.home);
  const catalog = await modelManager.getCatalog().catch(() => null);
  const foundModel = catalog?.models?.find((m) => m.modelId === activeModelId);

  const capabilities: string[] = [];
  if (foundModel?.tool_call) capabilities.push("tools");
  if (foundModel?.reasoning) capabilities.push("reasoning");
  if (foundModel?.attachment) capabilities.push("vision");

  const contextLimit = foundModel?.limit?.context ?? 128_000;
  const maxOutput = foundModel?.limit?.output;

  const usage = deps.session.getTokenUsage?.() ?? {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
  };

  const output = renderUsageBoxToString({
    model: activeModelId,
    capabilities,
    contextLimit,
    maxOutput,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cachedTokens: usage.cachedInputTokens ?? 0,
    totalTokens: usage.totalTokens,
    threadId: deps.session.thread.getId() ?? "new thread",
  });

  deps.showMessage(output);
};
