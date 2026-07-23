import { SystemMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { getPrompt } from "@/workflow/main/prompt/store.prompt.js";

interface SystemPromptParams {
  userId: string;
  agentId: string;
  timeZone: string;
  locale: string;
}

export const buildSystemPrompt = async (
  config: LangGraphRunnableConfig,
  { userId, agentId, timeZone, locale }: SystemPromptParams,
): Promise<SystemMessage> => {
  const [soul] = await Promise.all([
    getPrompt(config, userId, agentId, "soul"),
  ]);

  const parts: string[] = [];

  if (soul) parts.push(`<SOUL>\n${soul}\n</SOUL>`);

  if (timeZone || locale) {
    const userLines = ["<USER>"];
    if (timeZone) userLines.push(`User's timezone: ${timeZone}`);
    if (locale) userLines.push(`User's locale: ${locale}`);
    userLines.push("</USER>");
    parts.push(userLines.join("\n"));
  }

  return new SystemMessage(parts.join("\n\n"));
};