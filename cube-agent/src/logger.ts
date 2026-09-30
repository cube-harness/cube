import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { TransformCallback } from "node:stream";
import { format } from "node:util";
import { LoggerTransport } from "@mastra/core/logger";
import { PinoLogger } from "@mastra/loggers";
import type { HomeManager } from "@cube/workspace";

export interface CubeLogContext {
  threadId?: string;
}

export interface CubeLogging {
  logger: PinoLogger;
  close: () => Promise<void>;
}

const logContext = new AsyncLocalStorage<CubeLogContext>();

export const runWithCubeLogContext = <T>(context: CubeLogContext, callback: () => T): T =>
  logContext.run(
    {
      ...logContext.getStore(),
      ...context,
    },
    callback,
  );

const safeThreadFileName = (threadId: string): string => {
  const normalized = threadId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);

  return normalized && normalized !== "." && normalized !== ".." ? normalized : "unknown-thread";
};

class CubeFileTransport extends LoggerTransport {
  constructor(
    private readonly globalLogFile: string,
    private readonly threadLogDir: string,
  ) {
    super({ objectMode: true });
  }

  override _transform(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const raw = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = raw.split(/\r?\n/).filter(Boolean);

    void this.writeLines(lines).then(
      () => callback(null, chunk),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
  }

  private async writeLines(lines: string[]): Promise<void> {
    for (const line of lines) {
      const record = JSON.parse(line) as { threadId?: unknown };
      const target =
        typeof record.threadId === "string" && record.threadId.trim()
          ? path.join(this.threadLogDir, `${safeThreadFileName(record.threadId)}.log`)
          : this.globalLogFile;

      await appendFile(target, `${line}\n`, "utf8");
    }
  }
}

export const createCubeLogger = async (home: HomeManager): Promise<CubeLogging> => {
  const logDir = home.getLogDir();
  const threadLogDir = path.join(logDir, "threads");
  const globalLogFile = path.join(logDir, "cube.log");

  await mkdir(threadLogDir, { recursive: true });
  await appendFile(globalLogFile, "", "utf8");

  const transport = new CubeFileTransport(globalLogFile, threadLogDir);
  const logger = new PinoLogger({
    name: "cube",
    level: "info",
    prettyPrint: false,
    transports: { file: transport },
    mixin: () => logContext.getStore() ?? {},
    formatters: {
      log: (record) => {
        const error = record.error;
        return error instanceof Error
          ? { ...record, error: { ...error, name: error.name, message: error.message, stack: error.stack } }
          : record;
      },
    },
    redact: {
      paths: [
        "api_key",
        "apiKey",
        "access_token",
        "refresh_token",
        "authorization",
        "*.apiKey",
        "*.api_key",
        "*.access_token",
        "*.refresh_token",
        "headers.authorization",
        "headers.Authorization",
        "*.headers.authorization",
        "*.headers.Authorization",
        "requestHeaders.authorization",
        "requestHeaders.Authorization",
        "error.config.headers.authorization",
        "error.config.data.api_key",
        "error.config.data.apiKey",
        "error.config.data.access_token",
        "error.config.data.refresh_token",
        "callback.query.code",
        "callback.query.state",
        "request.body.access_token",
        "request.body.refresh_token",
        "response.body.access_token",
        "response.body.refresh_token",
        "error.requestBodyValues.contents[*].parts[*].thoughtSignature",
        "requestBodyValues.contents[*].parts[*].thoughtSignature",
      ],
      censor: "[Redacted]",
    },
  });

  // Mastra's skill registry bypasses its logger, including during lazy discovery.
  // ponytail: one CLI runtime owns console; use a shared dispatcher if runtimes coexist.
  const restoreConsole = (["warn", "error"] as const).map((level) => {
    const original = console[level];
    const redirect = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("[WorkspaceSkills]")) {
        logger[level](format(...args));
      } else {
        original.apply(console, args);
      }
    };
    console[level] = redirect;
    return () => {
      if (console[level] === redirect) console[level] = original;
    };
  });

  return {
    logger,
    close: () => {
      restoreConsole.forEach((restore) => restore());
      return new Promise<void>((resolve, reject) => {
        transport.once("error", reject);
        transport.end(resolve);
      });
    },
  };
};
