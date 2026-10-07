import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CubeHome } from "@cube/workspace";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { InMemoryStore } from "@mastra/core/storage";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { resolveAgentSkills } from "@mastra/core/skills";

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

test("persists thread logs and drains more than 16 entries without creating cube.log", { timeout: 10_000 }, async () => {
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
      for (let index = 0; index < 40; index++) logging.logger.info("thread event", { index });
    });
    await logging.close();
    logging.logger.error("late provider cleanup after shutdown");
    await new Promise((resolve) => setImmediate(resolve));
    logging.logger.error("second late provider cleanup after shutdown");
    await new Promise((resolve) => setImmediate(resolve));

    await assert.rejects(readFile(path.join(root, "logs", "cube.log")), { code: "ENOENT" });
    const threadLog = await readFile(
      path.join(root, "logs", "threads", "thread-123.log"),
      "utf8",
    );

    const records = threadLog.trim().split("\n").map((line) => JSON.parse(line));
    const threadRecord = records[0];
    assert.equal(records.length, 41);
    assert.deepEqual(records.slice(1).map((record) => record.index), Array.from({ length: 40 }, (_, index) => index));

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

test("malformed skills log diagnostics without writing into the terminal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-skill-logger-test-"));
  const terminal: unknown[][] = [];
  const error = t.mock.method(console, "error", (...args: unknown[]) => terminal.push(args));
  const warn = t.mock.method(console, "warn", (...args: unknown[]) => terminal.push(args));
  const { createCubeLogger, runWithCubeLogContext } = await import("../src/logger.js");
  const logging = await createCubeLogger(CubeHome({ cubeHome: root }));
  let closed = false;
  try {
    const skillsDir = path.join(root, "skills");
    for (const [name, description] of [["valid", "Valid skill"], ["broken", "Milestones: C1"]]) {
      const dir = path.join(skillsDir, name!);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nInstructions.`);
    }
    // First discovery can happen in a picker before a thread exists.
    assert.deepEqual((await resolveAgentSkills([skillsDir]).list()).map((skill) => skill.name), ["valid"]);
    await runWithCubeLogContext({ threadId: "skill-thread" }, async () => {
      assert.equal((await resolveAgentSkills([skillsDir]).list()).length, 1);
      console.warn("[WorkspaceSkills] Test skill warning");
    });
    assert.deepEqual(terminal, []);
    console.error("Unrelated CLI diagnostic");
    assert.deepEqual(terminal, [["Unrelated CLI diagnostic"]]);
    await logging.close();
    closed = true;
    assert.equal(console.error, error);
    assert.equal(console.warn, warn);
    await assert.rejects(readFile(path.join(root, "logs", "cube.log")), { code: "ENOENT" });
    const threadLog = await readFile(path.join(root, "logs", "threads", "skill-thread.log"), "utf8");
    assert.match(threadLog, /\[WorkspaceSkills\] Failed to load skill/);
    assert.match(threadLog, /Invalid skill metadata|incomplete explicit mapping pair/);
    assert.match(threadLog, /Test skill warning/);
  } finally {
    if (!closed) await logging.close();
    t.mock.restoreAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("public Mastra agent registration routes upstream failures to file, not the terminal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-provider-logger-test-"));
  const { createCubeLogger, runWithCubeLogContext } = await import("../src/logger.js");
  const logging = await createCubeLogger(CubeHome({ cubeHome: root }));
  const storage = new InMemoryStore();
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
  const agent = new Agent({ id: "logger-test", name: "Logger Test", instructions: "Test", model });
  const mastra = new Mastra({ logger: logging.logger, storage, agents: { agent } });
  const terminal = (["error", "warn", "log", "info", "debug"] as const).map((method) =>
    t.mock.method(console, method, () => undefined),
  );
  const stdout = t.mock.method(process.stdout, "write", () => true);
  const stderr = t.mock.method(process.stderr, "write", () => true);
  let closed = false;
  try {
    await assert.rejects(
      runWithCubeLogContext({ threadId: "test-thread" }, async () =>
        (await agent.stream("Test provider failure", { maxRetries: 0 })).getFullOutput(),
      ),
      /rate-limited upstream/,
    );
    await mastra.shutdown();
    await logging.close();
    closed = true;
    const records = (await readFile(path.join(root, "logs", "threads", "test-thread.log"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const failures = records.filter((record) => record.msg.includes("Upstream LLM API error"));
    assert.equal(failures.length, 1);
    for (const record of failures) {
      assert.equal(record.error.statusCode, 429);
      assert.match(record.error.message, /rate-limited upstream/);
      assert.equal(record.provider, "openrouter");
    }
    assert.equal(terminal.reduce((count, method) => count + method.mock.callCount(), 0), 0);
    assert.equal(stdout.mock.callCount(), 0);
    assert.equal(stderr.mock.callCount(), 0);
  } finally {
    t.mock.restoreAll();
    if (!closed) {
      await mastra.shutdown();
      await logging.close();
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
