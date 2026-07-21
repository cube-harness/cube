import { tool } from "@langchain/core/tools";
import * as z from "zod";
import { createLogger } from "@/config/logger.js";

const log = createLogger("get-time.tool");

const getTimeSchema = z.object({
  timeZone: z
    .string()
    .nullish()
    .describe(
      "IANA timezone, e.g. 'Asia/Tokyo', 'America/New_York', 'Europe/London'. " +
        "Set this when the user names a specific place or timezone (e.g. 'time in Japan'). " +
        "Omit it for a plain 'what time is it' question."
    ),
});

const isValidTimeZone = (tz: string): boolean => {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const getTimeTool = tool(
  async ({ timeZone }, config) => {
    // Đến đây context đã được guardrail validate ở node đầu graph rồi,
    // nên timeZone/locale chắc chắn tồn tại — không cần "as" ép kiểu mù.
    const contextTimeZone = config.configurable?.timeZone as string;
    const resolvedLocale = config.configurable?.locale as string;

    const resolvedTimeZone = timeZone ?? contextTimeZone;

    const runLog = log.child({
      threadId: config.configurable?.thread_id,
      requestedTimeZone: timeZone,
      contextTimeZone,
      resolvedTimeZone,
      resolvedLocale,
    });

    if (!isValidTimeZone(resolvedTimeZone)) {
      runLog.warn("Invalid timezone");
      return `Timezone "${resolvedTimeZone}" is invalid. Please use IANA format, e.g.: Asia/Tokyo, America/New_York, Europe/London.`;
    }

    const now = new Date();
    const date = new Intl.DateTimeFormat(resolvedLocale, { timeZone: resolvedTimeZone, dateStyle: "full" }).format(now);
    const time = new Intl.DateTimeFormat(resolvedLocale, { timeZone: resolvedTimeZone, timeStyle: "medium" }).format(now);

    runLog.info({ date, time }, "Successfully retrieved time");
    return JSON.stringify({ date, time, timezone: resolvedTimeZone, locale: resolvedLocale });
  },
  {
    name: "get_time",
    description: "Get the current date and time for a given IANA timezone.",
    schema: getTimeSchema,
  }
);