import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CubeHome } from "@cube/workspace";
import { Mastra } from "@mastra/core";
import type { Agent } from "@mastra/core/agent";
import { InMemoryStore } from "@mastra/core/storage";
import { ObservationalMemory } from "@mastra/memory/processors";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";

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
        api_key: "snake-secret",
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        headers: { authorization: "Bearer header-secret" },
        error: {
          config: {
            headers: { authorization: "Bearer nested-secret" },
            data: { access_token: "nested-access" },
          },
        },
      });
    });
    await logging.close();
    logging.logger.error("late provider cleanup after shutdown");
    await new Promise((resolve) => setImmediate(resolve));
    logging.logger.error("second late provider cleanup after shutdown");
    await new Promise((resolve) => setImmediate(resolve));

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
    assert.equal(globalLog.includes("late provider cleanup"), false);

    assert.equal(threadRecord.msg, "provider failed");
    assert.equal(threadRecord.threadId, "thread-123");
    assert.equal(threadRecord.runId, "run-456");
    assert.equal(threadRecord.apiKey, "[Redacted]");
    assert.equal(threadRecord.api_key, "[Redacted]");
    assert.equal(threadRecord.access_token, "[Redacted]");
    assert.equal(threadRecord.refresh_token, "[Redacted]");
    assert.equal(JSON.stringify(threadRecord).includes("header-secret"), false);
    assert.equal(JSON.stringify(threadRecord).includes("nested-secret"), false);
    assert.equal(JSON.stringify(threadRecord).includes("nested-access"), false);
    assert.equal(threadLog.includes("runtime started"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native Observer and Reflector log upstream failures to file, not the terminal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-om-logger-test-"));
  const { createCubeLogger, runWithCubeLogContext } = await import("../src/logger.js");
  const logging = await createCubeLogger(CubeHome({ cubeHome: root }));
  const storage = new InMemoryStore();
  const mastra = new Mastra({ logger: logging.logger, storage });
  const model = new MockLanguageModelV3({
    provider: "openrouter",
    modelId: "test-rate-limit",
    doStream: async () => {
      throw new APICallError({
        message: "Poolside test model is temporarily rate-limited upstream",
        url: "https://example.invalid/chat/completions",
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: false,
      });
    },
  });
  const memoryStorage = await storage.getStore("memory");
  assert.ok(memoryStorage);
  const om = new ObservationalMemory({ storage: memoryStorage, model });
  om.__registerMastra(mastra);
  // Exercise the pinned dependency's real factories/streams without OM's long 429 backoff.
  const agents: Agent[] = [
    Reflect.get(om.observer, "createAgent").call(om.observer, model),
    Reflect.get(om.observer, "createAgent").call(om.observer, model, true),
    Reflect.get(om.reflector, "createAgent").call(om.reflector, model),
  ];
  const terminal = (["error", "warn", "log", "info", "debug"] as const).map((method) =>
    t.mock.method(console, method, () => undefined),
  );
  let closed = false;
  try {
    for (const agent of agents) {
      await assert.rejects(
        runWithCubeLogContext({ threadId: "test-thread" }, async () =>
          (await agent.stream("Remember this test.", { maxRetries: 0 })).getFullOutput(),
        ),
        /rate-limited upstream/,
      );
    }
    await mastra.shutdown();
    await logging.close();
    closed = true;
    const records = (await readFile(path.join(root, "logs", "threads", "test-thread.log"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const failures = records.filter((record) => record.msg.includes("Upstream LLM API error"));
    assert.equal(failures.length, 3);
    for (const record of failures) {
      assert.equal(record.error.statusCode, 429);
      assert.match(record.error.message, /rate-limited upstream/);
      assert.equal(record.provider, "openrouter");
    }
    assert.equal(terminal.reduce((count, method) => count + method.mock.callCount(), 0), 0);
  } finally {
    t.mock.restoreAll();
    if (!closed) {
      await mastra.shutdown();
      await logging.close();
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
