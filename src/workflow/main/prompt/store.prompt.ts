import { getStore } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { createLogger } from "@/config/logger.js";

const log = createLogger("store.prompt-prompt");

type PromptKey = "soul";

const namespace = (userId: string, agentId: string) => ["users", userId, "agents", agentId, "prompt"];

export const getPrompt = async (
  config: LangGraphRunnableConfig,
  userId: string,
  agentId: string,
  key: PromptKey,
): Promise<string> => {
  const store = getStore(config);
  if (!store) {
    log.error({ userId, agentId, key }, "No store attached to config");
    return "";
  }

  const item = await store.get(namespace(userId, agentId), key);
  const content = (item?.value as { content?: string } | undefined)?.content;

  if (!content) {
    log.warn({ userId, agentId, key }, "Prompt not found in store");
    return "";
  }

  return content;
};

export const putPrompt = async (
  config: LangGraphRunnableConfig,
  userId: string,
  agentId: string,
  key: PromptKey,
  content: string,
): Promise<void> => {
  const store = getStore(config);
  if (!store) throw new Error("No store attached to config — cannot persist prompt");
  await store.put(namespace(userId, agentId), key, { content, updatedAt: new Date().toISOString() });
};