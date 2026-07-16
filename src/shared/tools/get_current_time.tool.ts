import { tool } from "@langchain/core/tools";
import * as z from "zod";
import type { ContextType } from "@/graph/main/context.js";

interface TimeToolContext {
  timeZone: string;
  locale: string;
}

interface GetCurrentTimeInput {
  timeZone?: string;
}

interface TimeToolRuntime {
  context?: Partial<ContextType>;
  configurable?: Partial<ContextType>;
}

function getServerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function getServerLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function getRuntimeContext(runtime?: TimeToolRuntime): Partial<ContextType> | undefined {
  return runtime?.context ?? runtime?.configurable;
}

function getTimeContext(
  input: GetCurrentTimeInput,
  runtime?: TimeToolRuntime
): TimeToolContext {
  const context = getRuntimeContext(runtime);
  const serverTimeZone = getServerTimeZone();
  const requestedTimeZone = input.timeZone?.trim();

  if (requestedTimeZone) {
    if (!isValidTimeZone(requestedTimeZone)) {
      throw new Error(`Invalid IANA time zone: "${requestedTimeZone}".`);
    }

    return {
      timeZone: requestedTimeZone,
      locale: context?.locale || getServerLocale(),
    };
  }

  const timeZone =
    context?.timeZone && isValidTimeZone(context.timeZone)
      ? context.timeZone
      : serverTimeZone;

  return {
    timeZone,
    locale: context?.locale || getServerLocale(),
  };
}

export const getCurrentTimeTool = tool(
  async (input, runtime) => {
    const now = new Date();
    const { timeZone, locale } = getTimeContext(
      input,
      runtime as TimeToolRuntime
    );

    const date = new Intl.DateTimeFormat(locale, {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(now);

    const time = new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(now);

    return JSON.stringify({ date, time, timeZone });
  },
  {
    name: "get_current_time",
    description:
      "Get the current date and time. If the user does not ask for a specific place, do not pass timeZone; the user's current time zone from runtime context is used.",
    schema: z.object({
      timeZone: z
        .string()
        .describe(
          "Optional IANA time zone for a specific place the user asks about. Use the Area/Location format, for example Europe/London, Europe/Paris, Asia/Tokyo, or America/New_York."
        )
        .optional(),
    }),
  }
);
