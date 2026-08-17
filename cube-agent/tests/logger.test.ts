import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLogger } from "../src/logger.js";

test("logger file and records use the thread identity", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "cube-logger-test-"));
  const logs = path.join(home, "logs");
  await mkdir(logs);
  const threadLog = (threadId: string): string =>
    path.join(logs, `agent-${threadId}.json`);
  const logPath = threadLog("thread-123");
  const cubeLogger = createLogger("thread-123", threadLog);

  try {
    cubeLogger.logger.info("identity-test");
    await cubeLogger.close();
    const record = JSON.parse((await readFile(logPath, "utf8")).trim()) as Record<
      string,
      unknown
    >;

    assert.equal(path.basename(logPath), "agent-thread-123.json");
    assert.equal(record.threadId, "thread-123");
    assert.equal("sessionId" in record, false);
  } finally {
    await cubeLogger.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});
