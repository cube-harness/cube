import { SUMMARY_MAX_WORDS } from "@/config/constant.js";

export function getUpdateSummaryPrompt(existingSummary: string): string {
  return `
You maintain short-term working memory for the current conversation.

Existing summary:
${existingSummary || "(empty)"}

New messages to compact are provided above.

Rules:
- Update the summary so it covers both the existing summary and the new messages.
- Preserve user preferences, goals, important facts, decisions, and unresolved tasks.
- Remove duplicate or outdated details.
- Keep the summary under ${SUMMARY_MAX_WORDS} words.
- Write the summary in the same language as the conversation.
- Return only the updated summary.
`.trim();
}
