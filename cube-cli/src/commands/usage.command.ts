import type { Home } from "@cube/workspace";
import { ConfigStore, ModelManager } from "@cube/workspace";
import type { Session } from "@cube/agent";
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

  const badges: string[] = [];
  if (foundModel?.tool_call) badges.push("tools");
  if (foundModel?.reasoning) badges.push("reasoning");
  if (foundModel?.attachment) badges.push("vision");
  const badgeStr = badges.length > 0 ? ` [${badges.join(", ")}]` : "";

  const contextLimit = foundModel?.limit?.context ?? 128_000;
  const outputLimit = foundModel?.limit?.output;

  const usage = deps.session.getTokenUsage?.() ?? {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
  };

  const percent = Math.min(
    100,
    Math.max(0, (usage.promptTokens / contextLimit) * 100),
  );
  const filledBars = Math.round((percent / 100) * 20);
  const emptyBars = 20 - filledBars;
  const progressBar = `[${"█".repeat(filledBars)}${"░".repeat(emptyBars)}]`;
  const remainingContext = Math.max(0, contextLimit - usage.promptTokens);

  const lines: string[] = [
    "### 📊 Token & Context Window Usage",
    `• Active Model:        \`${activeModelId}\`${badgeStr}`,
    `• Context Limit:       ${contextLimit.toLocaleString()} tokens${outputLimit ? ` (Max Output: ${outputLimit.toLocaleString()} tokens)` : ""}`,
    `• Context Window:      ${progressBar} ${percent.toFixed(1)}% (${usage.promptTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens)`,
    `• Remaining Context:   ${remainingContext.toLocaleString()} tokens`,
    "",
    `• Prompt Tokens:       ${usage.promptTokens.toLocaleString()}`,
    `• Completion Tokens:   ${usage.completionTokens.toLocaleString()}`,
    `• Cached Input Tokens: ${(usage.cachedInputTokens ?? 0).toLocaleString()}`,
    `• Total Tokens:        ${usage.totalTokens.toLocaleString()}`,
    `• Active Thread ID:    \`${deps.session.thread.getId() ?? "new thread"}\``,
  ];

  deps.showMessage(lines.join("\n"));
};
