import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CubeHome } from "@cube/workspace";

const loadLogging = async () => {
  const module = await import("../src/logger.js").catch(() => ({}));

  assert.equal(
    typeof (module as { createCubeLogger?: unknown }).createCubeLogger,
    "function",
    "createCubeLogger must exist",
  );
  assert.equal(
    typeof (module as { runWithCubeLogContext?: unknown }).runWithCubeLogContext,
    "function",
    "runWithCubeLogContext must exist",
  );

  return module as {
    createCubeLogger: (home: ReturnType<typeof CubeHome>) => Promise<{
      logger: {
        info: (message: string, args?: Record<string, unknown>) => void;
        error: (message: string, args?: Record<string, unknown>) => void;
      };
      close: () => Promise<void>;
    }>;
    runWithCubeLogContext: <T>(
      context: { threadId: string },
      callback: () => T,
    ) => T;
  };
};

test("routes global and thread logs to separate JSONL files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-logger-test-"));
  const home = CubeHome({ cubeHome: root });
  await home.ensure();

  try {
    const { createCubeLogger, runWithCubeLogContext } = await loadLogging();
    const logging = await createCubeLogger(home);

    logging.logger.info("runtime started", { component: "runtime" });
    await runWithCubeLogContext({ threadId: "thread-123" }, async () => {
      await Promise.resolve();
      logging.logger.error("provider failed", {
        runId: "run-456",
        apiKey: "must-not-be-written",
      });
    });
    await logging.close();

    const globalLog = await readFile(path.join(root, "logs", "cube.log"), "utf8");
    const threadLog = await readFile(
      path.join(root, "logs", "threads", "thread-123.log"),
      "utf8",
    );

    const globalRecord = JSON.parse(globalLog.trim()) as Record<string, unknown>;
    const threadRecord = JSON.parse(threadLog.trim()) as Record<string, unknown>;

    assert.equal(globalRecord.msg, "runtime started");
    assert.equal(globalRecord.component, "runtime");
    assert.equal(globalLog.includes("provider failed"), false);

    assert.equal(threadRecord.msg, "provider failed");
    assert.equal(threadRecord.threadId, "thread-123");
    assert.equal(threadRecord.runId, "run-456");
    assert.equal(threadRecord.apiKey, "[Redacted]");
    assert.equal(threadLog.includes("runtime started"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
