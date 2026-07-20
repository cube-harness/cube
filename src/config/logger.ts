import pino from "pino";
import { env } from "./env.js";

/**
 * Logger global cho toàn bộ project.
 * - Dev: pretty print, dễ đọc trên terminal.
 * - Production: JSON thuần, để pipe vào log aggregator (Railway logs, Loki, v.v.)
 * - Level điều khiển qua env.LOG_LEVEL (fatal/error/warn/info/debug/trace)
 */
export const logger = pino({
  level: env.LOG_LEVEL,

  // Gắn field cố định vào mọi log entry, để phân biệt nguồn khi gộp log
  // từ nhiều service (bot gateway, langgraph server) vào cùng 1 nơi.
  base: {
    service: "agentic-agent-langgraphjs",
    env: env.NODE_ENV,
  },

  // ISO time dễ đọc hơn epoch ms mặc định của pino.
  timestamp: pino.stdTimeFunctions.isoTime,

  // Serialize Error object đúng cách (message, stack, cause...).
  // Không có dòng này, log.error({ err }) với err là Error thật sẽ ra {}.
  serializers: {
    err: pino.stdSerializers.err,
  },

  // Chặn secret lọt ra log dù code có lỡ log nhầm object chứa field này.
  redact: {
    paths: [
      "*.apiKey",
      "*.GEMINI_API_KEY",
      "*.OPENAI_API_KEY",
      "*.TELEGRAM_BOT_TOKEN",
      "*.MONGODB_URI",
      "*.token",
      "*.password",
      "*.authorization",
      "*.headers.authorization",
    ],
    censor: "[REDACTED]",
  },

  transport:
    env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
          },
        }
      : undefined,
});

/**
 * Tạo logger con gắn context cố định (module/service name),
 * dùng ở đầu mỗi file thay vì gọi logger.info(...) trần trụi mỗi lần.
 *
 * Ví dụ:
 *   const log = createLogger("telegram-gateway");
 *   log.info({ chatId }, "Received message");
 *   // -> tự động kèm { module: "telegram-gateway", chatId }
 */
export function createLogger(module: string) {
  return logger.child({ module });
}

export type Logger = ReturnType<typeof createLogger>;

/**
 * Bắt lỗi chưa được xử lý ở cấp process, log đầy đủ trước khi crash.
 * Gọi 1 lần duy nhất ở entry point (main.ts / server.ts / bot.ts).
 */
export function registerGlobalErrorHandlers(): void {
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception - process sẽ thoát");
    process.exitCode = 1;
  });

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "Unhandled promise rejection");
  });
}