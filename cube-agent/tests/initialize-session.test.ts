import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isUserAuthoredMessage } from "@mastra/core/agent";
import { MockLanguageModelV3 } from "ai/test";
import { HomeManager, WorkspaceManager, createBootstrap, ConfigStore, RunnableConfigSchema } from "@cube/workspace";
import { createCubeMastra, type CubeMastraComposition } from "../src/bootstrap.js";
import { reloadCubeAgentInstructions } from "../src/agents/default.agent.js";
import { configureCubePermissions } from "../src/permission.js";
import { PromptService } from "../../cube-runtime/src/services/prompt.service.js";
import { ThreadService } from "../../cube-runtime/src/services/thread.service.js";
import type { SlashCommandContext } from "../../cube-runtime/src/slash-commands.js";

test("/init reaches the model, writes AGENTS through approval and persists hidden context for later turns", { timeout: 30_000 }, async t => {
  const root = process.env.CUBE_INIT_TEST_ROOT ?? await mkdtemp(join(tmpdir(), "cube-init-session-"));
  // Release native SQLite transaction handles before removing the fixture on Windows.
  if (process.platform === "win32" && !process.env.CUBE_INIT_TEST_ROOT) {
    try {
      const env = { ...process.env, CUBE_INIT_TEST_ROOT: root };
      delete env.NODE_TEST_CONTEXT;
      const result = await promisify(execFile)(process.execPath,
        ["--import", "tsx", "--test", import.meta.filename],
        { env, windowsHide: true, timeout: 25_000 });
      t.diagnostic(result.stdout);
      assert.match(result.stdout, /fail 0/);
      assert.equal(result.stderr, "");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    return;
  }
  let composition: CubeMastraComposition | undefined;
  try {
    const project = join(root, "project");
    await mkdir(project);
    await writeFile(join(project, "README.md"), "Example Python project. Run pytest.\n");
    const home = new HomeManager({ cubeHome: join(root, "home"), userHome: root });
    await createBootstrap(home).run();
    const config = RunnableConfigSchema.parse({ ...await ConfigStore(home).read(), gateway: "api_key/google", model: "google/test" });
    const workspace = new WorkspaceManager(home, project);
    composition = await createCubeMastra(home, workspace, config);
    const requests: string[] = [];
    composition.agent.model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
      requests.push(JSON.stringify(prompt));
      const call = requests.length === 1
        ? { type: "tool-call", toolCallId: "read-project", toolName: "read_file", input: JSON.stringify({ path: "README.md" }) }
        : requests.length === 2
          ? { type: "tool-call", toolCallId: "write-instructions", toolName: "write_file", input: JSON.stringify({ path: "AGENTS.md", content: "# AGENTS.md\nRun pytest.\n" }) }
          : undefined;
      return { stream: new ReadableStream({ start(stream) {
        for (const chunk of [
          { type: "stream-start", warnings: [] },
          ...(call ? [call] : [
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "Done." },
            { type: "text-end", id: "answer" },
          ]),
          { type: "finish", finishReason: { unified: call ? "tool-calls" : "stop", raw: call ? "tool_calls" : "stop" }, usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
          } },
        ]) stream.enqueue(chunk);
        stream.close();
      } }) };
    } });
    const session = await composition.controller.createSession({ resourceId: project });
    await configureCubePermissions(session, config.permissions);
    const startupId = session.thread.getId();
    if (startupId) await session.thread.delete({ threadId: startupId });
    const thread = new ThreadService(session, {
      read: composition.agent.readInstructions,
      install: composition.agent.installInstructions,
      reload: (includeDiscovered) => reloadCubeAgentInstructions(composition!.agent, home, workspace, includeDiscovered),
      refresh: composition.agent.refreshInstructions,
    }, () => "init-thread");
    const commands = {
      gateway: { readiness: async () => ({ ready: true }) },
      memory: { isBusy: () => false },
      prompt: { initialize: () => service.initialize() },
    } as unknown as SlashCommandContext;
    const history: string[] = [];
    const service = new PromptService(home, session, thread, commands, (callback) => callback(), async (text) => { history.push(text); });
    const errors: unknown[] = [];
    const approvals: string[] = [];
    session.subscribe((event) => {
      if (event.type === "error") errors.push(event.error);
      if (event.type === "tool_approval_required") {
        approvals.push(event.toolName);
        session.respondToToolApproval({ decision: "approve", toolCallId: event.toolCallId });
      }
    });
    let echoes = 0;
    assert.deepEqual(await service.submit("/init", () => { echoes++; }), { kind: "submitted" });
    assert.deepEqual(errors, []);
    assert.deepEqual(approvals, ["write_file"]);
    assert.equal(await readFile(join(project, "AGENTS.md"), "utf8"), "# AGENTS.md\nRun pytest.\n");
    assert.equal(echoes, 0);
    assert.deepEqual(history, ["/init"]);
    assert.equal(requests.length, 3);
    for (const request of requests) {
      const conversation = JSON.stringify((JSON.parse(request) as { role: string }[])
        .filter(message => message.role !== "system"));
      assert.match(conversation, /analyze this codebase/);
      assert.doesNotMatch(conversation, /\/init|cube-cli|cube-workspace/);
    }
    assert.match(requests[1]!, /Example Python project/);
    const messages = await session.thread.listMessages({ threadId: "init-thread" });
    const init = messages.filter(isUserAuthoredMessage).find((message) => (message.content.metadata?.signal as any)?.metadata?.cube)!;
    assert.ok(init);
    assert.equal((init.content.metadata!.signal as any).metadata.cube.displayText, "");
    assert.equal(init.content.parts.filter((part) => part.type === "text" && part.text.includes("analyze this codebase")).length, 1);
    const memory = await composition.mastra.getStorage()!.getStore("memory");
    const restored = await memory!.listMessages({ threadId: "init-thread", perPage: false });
    assert.deepEqual(restored.messages.find((message) => message.id === init.id)?.content, init.content);
    const fork = await memory!.cloneThread({ sourceThreadId: "init-thread", newThreadId: "init-fork" });
    assert.equal((fork.clonedMessages.find((message) => (message.content.metadata?.signal as any)?.metadata?.cube)?.content.metadata!.signal as any).metadata.cube.displayText, "");
    await service.submit("Continue normally", () => { echoes++; });
    assert.deepEqual(errors, []);
    assert.equal(echoes, 1);
    assert.equal(requests.length, 4);
    assert.equal((requests[3]!.match(/analyze this codebase/g) ?? []).length, 1);
    assert.equal(composition.agent.instructionInfo.agentsFiles, 0, "init does not reload the instruction snapshot");
    assert.ok(requests.every((request) => !request.includes("<agents_instructions>")));
    await thread.reload();
    assert.equal(composition.agent.instructionInfo.agentsFiles, 1);
    assert.equal(composition.agent.readInstructions().sources[0]?.content, "# AGENTS.md\nRun pytest.");
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
  } finally {
    await composition?.shutdown();
    if (!process.env.CUBE_INIT_TEST_ROOT)
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
