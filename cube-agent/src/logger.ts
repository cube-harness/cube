import { appendFileSync } from "node:fs";
import { PinoLogger } from "@mastra/loggers";
import { FileTransport } from "@mastra/loggers/file";
import type { AgentRuntimeFiles } from "@cube/workspace";

export const createLogger = (
  threadId: string,
  threadLog: AgentRuntimeFiles["threadLog"],
) => {
  const logPath = threadLog(threadId);
  appendFileSync(logPath, "", { encoding: "utf8" });
  const fileTransport = new FileTransport({ path: logPath });
  let closePromise: Promise<void> | undefined;

  const logger = new PinoLogger({
    name: `cube-${threadId.slice(0, 8)}`,
    level: "info",
    transports: {
      file: fileTransport,
    },
    prettyPrint: false,
    mixin: () => ({ threadId }),
  });

  const close = (): Promise<void> => {
    closePromise ??= new Promise<void>((resolve, reject) => {
      fileTransport.once("error", reject);
      fileTransport.end(resolve);
    });
    return closePromise;
  };

  return { logger, close };
};
