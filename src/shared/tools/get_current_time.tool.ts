import { tool } from "@langchain/core/tools";
import * as z from "zod";
import type { ContextType } from "@/graph/main/context.js";

interface TimeToolContext {
  timeZone: string;
  locale: string;
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

function getTimeContext(runtime?: TimeToolRuntime): TimeToolContext {
  const context = getRuntimeContext(runtime);
  const serverTimeZone = getServerTimeZone();
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
  async (_input, runtime) => {
    const now = new Date();
    const { timeZone, locale } = getTimeContext(runtime as TimeToolRuntime);

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
      "Get the current date, time, and time zone for the current user.",
    schema: z.object({}),
  }
);
