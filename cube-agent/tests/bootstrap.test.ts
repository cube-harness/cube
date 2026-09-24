import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { MockLanguageModelV3 } from "ai/test";
import { ConfigStore, CubeHome, CubeWorkspace, RunnableConfigSchema, createBootstrap } from "@cube/workspace";
import { createCubeMastra } from "../src/bootstrap.js";
import { runWithCubeLogContext } from "../src/logger.js";
import { configureCubePermissions } from "../src/permission.js";

test("createCubeMastra composes the agent and controller into one Mastra runtime", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-agent-bootstrap-test-"));
  const home = CubeHome({ cubeHome: path.join(root, ".cube") });
  t.mock.method(home, "getMemoryDbPath", () => ":memory:");
  await home.ensure();
  await createBootstrap(home).run();
  const workspace = CubeWorkspace(home, root);

  let composition:
    | Awaited<ReturnType<typeof createCubeMastra>>
    | undefined;

  try {
    const config = RunnableConfigSchema.parse({ ...await ConfigStore(home).read(), gateway: "api_key/google", model: "google/test" });
    composition = await createCubeMastra(home, workspace, config);

    assert.equal(composition.controller.getMastra(), composition.mastra);
    assert.equal(composition.mastra.getAgentById("cube-agent"), composition.agent);
    assert.ok(composition.mastra.getStorage());
    assert.equal((await composition.agent.listTools()).execute_command, composition.tools.forModel(config.model).execute_command);
    let requests = 0;
    composition.agent.model = new MockLanguageModelV3({
      doStream: async () => {
        const first = requests++ === 0;
        const input = JSON.stringify({ path: "." });
        return { stream: new ReadableStream({ start(controller) {
          const chunks = [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: "private-response-content" },
            { type: "text-end", id: "text" },
            ...(first ? [
              { type: "tool-input-start", id: "list-call", toolName: "list_files" },
              { type: "tool-input-delta", id: "list-call", delta: input },
              { type: "tool-input-end", id: "list-call" },
              { type: "tool-call", toolCallId: "list-call", toolName: "list_files", input },
            ] : []),
            { type: "finish", finishReason: { unified: first ? "tool-calls" : "stop", raw: first ? "tool_calls" : "stop" },
              usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } },
          ];
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        } }) };
      },
    });
    const session = await composition.controller.createSession({ resourceId: root });
    await configureCubePermissions(session, { require_approval_for: [] });
    await session.thread.create({ id: "stream-boundaries" });
    await runWithCubeLogContext({ threadId: "stream-boundaries" }, () =>
      session.followUp({ content: "private-user-content" }));
    assert.equal(requests, 2);
    assert.equal(session.run.isRunning(), false);
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
    // Studio calls the exported Mastra shutdown, rather than CubeRuntime.shutdown.
    composition.mastra.shutdown = composition.shutdown;
    await composition.mastra.shutdown();
    const log = await readFile(path.join(home.getLogDir(), "threads", "stream-boundaries.log"), "utf8");
    const boundaries = log.trim().split("\n").map((line) => JSON.parse(line))
      .filter((record) => record.msg === "Agent stream boundary");
    for (const event of ["text-delta", "tool-call-input-streaming-start", "tool-call", "step-finish", "finish"]) {
      assert.ok(boundaries.some((record) => record.event === event), `missing ${event}: ${boundaries.map((record) => record.event).join(", ")}`);
    }
    assert.ok(boundaries.some((record) => record.toolName === "list_files"));
    assert.doesNotMatch(JSON.stringify(boundaries), /private-user-content|private-response-content|"args"|"prompt"/);
    const command = composition.tools.forModel(config.model).execute_command;
    assert.ok("execute" in command && command.execute);
    await assert.rejects(command.execute({ command: "echo never", reason: "closed runtime" }, {} as never), /closed/);
  } finally {
    await composition?.shutdown();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
