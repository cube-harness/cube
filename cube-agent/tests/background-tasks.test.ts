import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MockLanguageModelV3 } from "ai/test";
import { CubeHome, CubeWorkspace, RunnableConfigSchema, createBootstrap } from "@cube/workspace";
import { createCubeMastra } from "../src/bootstrap.js";
import { configureCubePermissions } from "../src/permission.js";
import { BackgroundService } from "../../cube-runtime/src/services/background.service.js";

async function eventually(predicate: () => Promise<boolean> | boolean, message: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(message);
}

async function cleanup(root: string) {
  // LibSQL transaction connections remain file-locked on Windows until process exit.
  if (process.env.CUBE_TASK_TEST_ROOT) return;
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

if (process.platform === "win32" && !process.env.CUBE_TASK_TEST_ROOT) {
  test("Cube background integration (isolated SQLite fixtures)", { timeout: 60000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cube-task-suite-"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, CUBE_TASK_TEST_ROOT: root };
      delete env.NODE_TEST_CONTEXT;
      const result = await promisify(execFile)(process.execPath,
        ["--import", "tsx", "--test", import.meta.filename], {
          env, windowsHide: true,
        });
      t.diagnostic(result.stdout);
      assert.match(result.stdout, /tests [1-9]/);
      assert.equal(result.stderr, "");
    } finally {
      await cleanup(root);
    }
  });
} else {
for (const decision of ["approve", "decline"] as const) {
  test(`Cube background completion preserves the next tool approval: ${decision}`, { timeout: 30000 }, async () => {
    const root = await mkdtemp(join(process.env.CUBE_TASK_TEST_ROOT ?? tmpdir(), "cube-task-approval-"));
    const home = CubeHome({ cubeHome: join(root, ".cube"), userHome: root });
    await createBootstrap(home).run();
    await writeFile(join(root, "demo.txt"), "APPROVED_READ");
    const config = RunnableConfigSchema.parse({
      gateway: "api_key/google", model: "google/test", memory: { durable: { enabled: false } },
      background_tasks: { timeout_ms: 5000 }, permissions: { require_approval_for: ["read_file"] },
    });
    const composition = await createCubeMastra(home, CubeWorkspace(home, root), config);
    const history = (await composition.mastra.getStorage()!.getStore("backgroundTasks"))!;
    const session = await composition.controller.createSession({ resourceId: root });
    const service = new BackgroundService({
      history: () => composition.mastra.getStorage()!.getStore("backgroundTasks"),
      processes: composition.tools.processes, workspaceRoot: root,
      currentThread: () => session.thread.getId(), notice: () => {},
      redact: composition.redact, drain: composition.drain, continueProcess: composition.continueProcess,
    });
    let approval: string | undefined;
    const errors: unknown[] = [];
    const prompts: unknown[] = [];
    let calls = 0;
    const unsubscribe = session.subscribe(event => {
      if (event.type === "tool_approval_required") approval = event.toolCallId;
      if (event.type === "error") errors.push(event.error);
    });
    composition.agent.model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
      prompts.push(prompt);
      const number = calls++;
      if (number === 1) await delay(200);
      const name = number === 0 ? "execute_command" : number === 1 ? "read_file" : undefined;
      const input = number === 0 ? { command: "echo BUILD_OK", reason: "Build before approved read", background: true } : { path: "demo.txt" };
      return { stream: new ReadableStream({ start(stream) {
        stream.enqueue({ type: "stream-start", warnings: [] });
        if (name) stream.enqueue({ type: "tool-call", toolCallId: `approval-${number}`, toolName: name, input: JSON.stringify(input) });
        stream.enqueue({ type: "finish", finishReason: { unified: name ? "tool-calls" : "stop", raw: name ? "tool_calls" : "stop" }, usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 2, reasoning: 0 },
        } });
        stream.close();
      } }) };
    } });
    try {
      await configureCubePermissions(session, config.permissions);
      await session.thread.create({ id: "approval-owner" });
      const turn = session.followUp({ content: "Build then read demo.txt" });
      void turn.catch(error => errors.push(error));
      await eventually(() => Boolean(approval), "Missing read approval");
      await eventually(async () => (await history.listTasks({ threadId: "approval-owner", status: "completed" })).tasks.length === 1, "Background command did not finish");
      // Leave the picker open while the completion is delivered: the reported race.
      await delay(300);
      assert.equal(calls, 2, "Completion must not replace the pending approval");
      session.respondToToolApproval({ toolCallId: approval!, decision, ...(decision === "decline" ? { declineContext: { reason: "User declined tool execution." } } : {}) });
      await eventually(() => calls === 3 && !session.run.isRunning(), "Approval did not resume the model");
      await turn;
      assert.deepEqual(errors, []);
      const toolHistory = JSON.stringify((prompts.at(-1) as { role: string }[]).filter(message => message.role === "tool"));
      assert.match(toolHistory, decision === "approve" ? /APPROVED_READ/ : /User declined tool execution/);
      assert.equal(session.followUps.count(), 0);
    } finally {
      session.abort(); unsubscribe();
      await service.shutdown();
      session.thread.detachFromCurrent(); await session.thread.clearAndReleaseLock();
      await composition.shutdown();
      await cleanup(root);
    }
  });
}

for (const mode of ["omitted", "foreground", "background", "concurrent", "unselected", "approved", "declined", "invalid", "timeout", "cancel", "disabled", "persistent", "managed", "denied"] as const) {
test(`Cube background: ${mode}`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(process.env.CUBE_TASK_TEST_ROOT ?? tmpdir(), "cube-background-"));
  const home = CubeHome({ cubeHome: join(root, ".cube"), userHome: root });
  await createBootstrap(home).run();
  const config = RunnableConfigSchema.parse({
    gateway: "api_key/google", model: "google/test",
    memory: { durable: { enabled: false } },
    background_tasks: { enabled: mode !== "disabled", timeout_ms: mode === "timeout" ? 1000 : 10000 },
    permissions: { require_approval_for: ["approved", "declined"].includes(mode) ? ["execute_command"] : [], deny_for: mode === "denied" ? ["execute_command"] : [] },
  });
  const composition = await createCubeMastra(home, CubeWorkspace(home, root), config);
  assert.equal(composition.mastra.backgroundTaskManager, undefined);
  assert.equal(composition.agent.getBackgroundTasksConfig(), undefined);
  assert.equal((await composition.agent.listTools({ resolveWebSearch: false })).fetch, undefined);
  const history = (await composition.mastra.getStorage()!.getStore("backgroundTasks"))!;
  const session = await composition.controller.createSession({ resourceId: root });
  const notices: string[] = [];
  const service = new BackgroundService({
    history: () => composition.mastra.getStorage()!.getStore("backgroundTasks"),
    processes: composition.tools.processes, workspaceRoot: root,
    currentThread: () => session.thread.getId(), notice: message => notices.push(message),
    redact: composition.redact, drain: composition.drain,
    continueProcess: composition.continueProcess,
  });
  composition.tools.setTaskHandler(async (input, threadId) => {
    if (input.action === "list") return { tasks: await service.list(threadId) };
    if (input.action === "kill") await service.stop(input, threadId);
    return service.get(input, threadId);
  });
  let calls = 0, inFlight = 0, maxInFlight = 0;
  const prompts: any[] = [];
  const secondStarted = Promise.withResolvers<void>();
  const secondRelease = Promise.withResolvers<void>();
  const errors: unknown[] = [];
  const events: string[] = [];
  const foreground = mode === "omitted" || mode === "foreground";
  const command = ["omitted", "foreground", "background", "concurrent", "unselected", "approved", "cancel", "timeout"].includes(mode)
    ? `node -e "console.log('BUILD_STARTED');const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync('release-task')){clearInterval(t);console.log('BUILD_OK')}},20)"`
    : ["persistent", "managed"].includes(mode) ? `node -e "console.log('MANAGED_LOG');setInterval(()=>{},1000)"` : `node -e "console.log('BUILD_OK')"`;
  const input = {
    command, reason: "Test command policy and continuation",
    ...(mode === "omitted" ? {} : { background: mode !== "foreground" }),
    ...(mode === "invalid" ? { cwd: ".." } : {}),
    ...(["persistent", "managed"].includes(mode) ? { timeout: null } : {}),
    _background: { enabled: true, timeoutMs: 99999999, maxRetries: 9 },
  };
  composition.agent.model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
    const number = calls++;
    prompts.push(prompt);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    if (mode === "concurrent" && number === 2) { secondStarted.resolve(); await secondRelease.promise; }
    return { stream: new ReadableStream({ start(stream) {
      stream.enqueue({ type: "stream-start", warnings: [] });
      if (number === 0) stream.enqueue({ type: "tool-call", toolCallId: "build-call", toolName: "execute_command", input: JSON.stringify(input) });
      else if (mode === "managed" && number <= 3) {
        const id = composition.tools.processes.list()[0]!.id;
        stream.enqueue({ type: "tool-call", toolCallId: `manage-${number}`, toolName: "manage_task",
          input: JSON.stringify(number === 1 ? { action: "list" } : { action: number === 2 ? "get" : "kill", id }),
        });
      }
      else {
        stream.enqueue({ type: "text-start", id: `answer-${number}` });
        stream.enqueue({ type: "text-delta", id: `answer-${number}`, delta: number === 1 ? "Independent work" : `Verified response ${number}` });
        stream.enqueue({ type: "text-end", id: `answer-${number}` });
      }
      const tool = number === 0 || (mode === "managed" && number <= 3);
      stream.enqueue({ type: "finish", finishReason: { unified: tool ? "tool-calls" : "stop", raw: tool ? "tool_calls" : "stop" }, usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 2, text: 2, reasoning: 0 },
      } });
      inFlight--;
      stream.close();
    } }) };
  } });
  let approvals = 0;
  const unsubscribe = session.subscribe(event => {
    if (event.type === "error") errors.push(event.error);
    if (event.type === "agent_end") events.push(event.reason);
    if (event.type === "tool_approval_required") {
      approvals++;
      session.respondToToolApproval({ toolCallId: event.toolCallId, decision: mode === "declined" ? "decline" : "approve" });
    }
  });
  try {
    await configureCubePermissions(session, config.permissions);
    await session.thread.create({ id: "background-owner" });
    const first = session.followUp({ content: "Build and do independent work" });
    void first.catch(error => errors.push(error));
    if (foreground) {
      await eventually(() => composition.tools.processes.list().some(record => record.result.output.includes("BUILD_STARTED")), "Foreground command did not start");
      assert.equal(calls, 1, "Model must wait for the actual command result");
      assert.equal(session.run.isRunning(), true);
      assert.deepEqual(await service.list(), [], "A normal command must not become a background job");
      assert.equal((await history.listTasks({ threadId: "background-owner" })).tasks.length, 0);
      await writeFile(join(root, "release-task"), "go");
      await eventually(() => calls === 2 && !session.run.isRunning(), "Foreground command did not return its result");
      await first;
      await composition.drain();
      const results = prompts.at(-1).filter((message: any) => message.role === "tool");
      assert.match(JSON.stringify(results), /BUILD_OK/);
      assert.equal(composition.tools.processes.list()[0]!.detached, false);
      assert.deepEqual(await service.list(), []);
      assert.equal(calls, 2, "Normal completion must not trigger a background continuation");
    } else await eventually(() => calls >= 2 && !session.run.isRunning(), "Independent reply did not release the foreground turn");
    if (foreground) {
      assert.deepEqual(notices, []);
    } else if (["background", "concurrent", "unselected", "approved", "timeout", "cancel"].includes(mode)) {
      await eventually(async () => (await service.list()).length === 1, "No background process dispatched");
      const task = (await history.listTasks({ resourceId: root })).tasks[0]!;
      assert.equal(task.maxRetries, 0);
      assert.equal(task.timeoutMs, config.background_tasks.timeout_ms);
      assert.equal(task.threadId, "background-owner");
      if (["background", "concurrent", "unselected", "approved"].includes(mode)) {
        await eventually(async () => (await service.get({ id: task.id })).output.includes("BUILD_STARTED"), "Live command output was not linked to its task");
      }
      if (mode === "unselected") {
        await session.thread.clearAndReleaseLock();
        await session.thread.create({ id: "another-thread" });
        await writeFile(join(root, "release-task"), "go");
        await eventually(async () => (await history.getTask(task.id))?.status === "completed", "Unselected build did not finish");
        await service.list(); // Drain persistence and delivery without waking the unselected thread.
        await composition.drain();
        assert.equal(calls, 2, "Completion must not wake a thread the user has left");
        assert.deepEqual(await service.list(), []);
        const stored = await session.thread.listMessages({ threadId: "background-owner" });
        assert.ok(stored.some((message: any) => message.role === "signal" && JSON.stringify(message).includes("BUILD_OK")));
        await session.thread.clearAndReleaseLock();
        await session.thread.switch({ threadId: "background-owner" });
        assert.equal((await service.list())[0]!.status, "completed");
      } else if (mode === "concurrent") {
        const second = session.followUp({ content: "Review the project while the build runs" });
        await secondStarted.promise;
        await writeFile(join(root, "release-task"), "go");
        await eventually(async () => (await history.getTask(task.id))?.status === "completed", "Build did not finish during new prompt");
        assert.equal(calls, 3, "Completion continuation overlapped the new model turn");
        secondRelease.resolve();
        await second;
        await eventually(() => calls >= 4 && !session.run.isRunning(), "Completion or second prompt was stranded");
      } else if (mode === "cancel") {
        await service.stop({ id: task.id });
        await eventually(() => composition.tools.processes.list().every(record => record.result.status !== "running"), "Killed task left its command process running");
      }
      else if (mode !== "timeout") await writeFile(join(root, "release-task"), "go");
      await eventually(async () => !["pending", "running", "suspended"].includes((await history.getTask(task.id))!.status), "Task did not terminate");
      await eventually(() => !session.run.isRunning(), "Session continuation did not finish");
      await composition.drain();
      const finished = await history.getTask(task.id);
      assert.equal(finished?.status, mode === "timeout" ? "timed_out" : mode === "cancel" ? "cancelled" : "completed");
      if (["background", "concurrent", "approved"].includes(mode)) {
        assert.ok(calls >= 3, "The same coding model must receive completion");
        const results = prompts;
        assert.ok(JSON.stringify(results).includes("BUILD_OK"), "Actual output never reached model");
        const stored = await session.thread.listMessages({ threadId: "background-owner" });
        const actual = stored.filter((message: any) => message.role === "signal" && JSON.stringify(message).includes("BUILD_OK"));
        assert.equal(actual.length, 1, "Actual result must persist exactly once");
        assert.ok(JSON.stringify(session.displayState.get()).includes("Verified response"), "Continuation missing from display");
      }
      assert.deepEqual(notices, []);
    } else if (mode === "managed") {
      const record = composition.tools.processes.list()[0]!;
      assert.equal(record.result.status, "cancelled");
      assert.equal((await history.getTask(record.id))?.status, "cancelled");
      assert.equal((await service.get(record)).id, record.result.process_id);
      const results = JSON.stringify(prompts.filter((_: unknown, index: number) => index >= 2));
      assert.match(results, /manage_task/);
      assert.match(results, /"tasks"/);
      assert.match(results, /cancelled/);
      assert.ok(calls >= 5, "The model must receive list, get and kill results in one run");
      assert.deepEqual(notices, []);
    } else if (mode === "persistent") {
      const process = (await service.list())[0]!;
      assert.equal(process.status, "running");
      assert.equal(process.threadId, "background-owner");
      await service.beforeDelete("background-owner");
      assert.equal((await service.get(process)).ownerDeleted, true);
      await service.stop(process);
      assert.deepEqual(notices, []);
    } else {
      assert.equal((await service.list()).length, 0);
      assert.equal(composition.tools.processes.list().length, 0, "Rejected request spawned a command");
    }
    await first;
    assert.equal(approvals, ["approved", "declined"].includes(mode) ? 1 : 0);
    assert.equal(maxInFlight, 1, "Concurrent unsafe model runs");
    assert.equal(session.followUps.count(), 0);
    assert.equal(session.run.isRunning(), false);
    assert.deepEqual(errors, []);
  } finally {
    secondRelease.resolve();
    await writeFile(join(root, "release-task"), "go");
    session.abort();
    unsubscribe();
    await service.shutdown();
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
    await composition.shutdown();
    await cleanup(root);
  }
});
}
}
