import { isUserAuthoredMessage, type MastraDBMessage } from "@mastra/core/agent";
import type { InputProcessor } from "@mastra/core/processors";

type EnvironmentTime = { date: string; timezone: string };

export function readEnvironmentTime(now = new Date(), timezone?: string): EnvironmentTime {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    timezone: formatter.resolvedOptions().timeZone,
  };
}

export function isEnvironmentContext(message: MastraDBMessage): boolean {
  const signal = message.content.metadata?.signal as {
    type?: string;
    tagName?: string;
    metadata?: { cube?: { kind?: string } };
  } | undefined;
  return message.role === "signal" && signal?.type === "reactive" &&
    signal.tagName === "environment_context" && signal.metadata?.cube?.kind === "environment-context";
}

export const createEnvironmentProcessor = (
  readTime: () => EnvironmentTime = readEnvironmentTime,
): InputProcessor => ({
  id: "cube-environment",
  async processInputStep({ messageList, requestContext, sendSignal }) {
    const messages = messageList.get.all.db();
    const trigger = messages.filter(isUserAuthoredMessage).at(-1)?.id;
    // Native Session may rebuild processor state between tool steps. Keep the
    // clock snapshot on its request context, keyed by the actual user message.
    const previous = requestContext?.get("cubeEnvironmentTime") as {
      trigger?: string; time: EnvironmentTime;
    } | undefined;
    const time = previous && previous.trigger === trigger ? previous.time : readTime();
    requestContext?.set("cubeEnvironmentTime", { trigger, time });
    const latest = messages.filter(isEnvironmentContext).at(-1);
    const attributes = (latest?.content.metadata?.signal as {
      attributes?: { current_date?: string; timezone?: string };
    } | undefined)?.attributes;
    if (attributes?.current_date === time.date && attributes.timezone === time.timezone) return;
    if (!sendSignal) throw new Error("Environment context requires native signal delivery.");
    await sendSignal({
      type: "reactive",
      tagName: "environment_context",
      transient: false,
      attributes: { current_date: time.date, timezone: time.timezone },
      metadata: { cube: { kind: "environment-context" } },
      contents: "Host-local date and timezone for this run; use the newest environment context for relative dates.",
    });
  },
});
