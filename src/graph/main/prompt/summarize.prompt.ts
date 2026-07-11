import { SUMMARY_MAX_WORDS } from "@/config/constant.js";

const SUMMARY_BASE_RULES = `
      Rules:
      - Capture user preferences, goals, important facts, and ongoing tasks.
      - Exclude greetings, filler, and repetitive details.
      - Write the summary in the same language as the conversation.
      - Keep the summary under ${SUMMARY_MAX_WORDS} words.
      `;

const SUMMARY_UPDATE_EXTRA_RULES = `
      - Preserve important user facts and preferences.
      - Preserve important decisions and unresolved tasks.
      - Remove duplicated or outdated information.
      `;

export function getNewSummaryPrompt(): string {
  return `
    You maintain the conversation memory for an AI assistant.
    Summarize the conversation.
    ${SUMMARY_BASE_RULES}- Return only the summary.
    `;
}

export function getUpdateSummaryPrompt(existingSummary: string): string {
  return `
    You maintain the conversation memory for an AI assistant.
    Existing summary:
    ${existingSummary}
    Update the summary using the new conversation above.
    ${SUMMARY_BASE_RULES}${SUMMARY_UPDATE_EXTRA_RULES}- Return only the updated summary.
    `;
}
