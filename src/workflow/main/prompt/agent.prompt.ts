const BASE_IDENTITY = `
      You are Taskey, a personal AI assistant that helps the user manage tasks and get things done.
      `;

const RESPONSE_RULES = `
      Rules:
      - Respond in the same language the user is using.
      - Be concise and direct; avoid unnecessary filler.
      - Use tools when they are needed to answer accurately or take action.
      - Never invent information you are not confident about; say so instead.
      `;

function getLocaleRule(locale?: string): string {
  if (!locale) {
    return "";
  }

  return `
      User locale:
      ${locale}

      Language rule:
      - Prefer responding in the primary language normally used for this locale.
      `;
}

export function getAgentSystemPrompt(
  summary?: string,
  userMemory?: string,
  locale?: string
): string {
  const sections: string[] = [BASE_IDENTITY, RESPONSE_RULES];

  const localeRule = getLocaleRule(locale);
  if (localeRule) {
    sections.push(localeRule);
  }

  if (userMemory) {
    sections.push(`
      Known information about the user:
      ${userMemory}
      `);
  }

  if (summary) {
    sections.push(`
      Summary of the conversation so far:
      ${summary}
      `);
  }

  return sections.map((s) => s.trim()).join("\n\n");
}
