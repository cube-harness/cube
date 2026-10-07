import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCommandTools } from "../src/tools/command.tools.js";
import { RequestContext } from "@mastra/core/request-context";

test("detached no-deadline process exposes owned immutable snapshots and terminal updates", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cube-process-registry-"));
  const commands = createCommandTools(root);
  t.after(async () => { await commands.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const events: string[] = [];
  const unsubscribe = commands.processes.subscribe((record) => {
    if (record.completedAt) events.push(record.result.status);
  });
  const requestContext = new RequestContext();
  requestContext.set("cubeBackgroundRunId", "owner-run");
  const result = await commands.tools.execute_command.execute!({
    command: 'node -e "console.log(\'REGISTRY_OK\');setInterval(()=>{},1000)"',
    reason: "Test detached ownership", background: true, timeout: null,
  } as never, { agent: { threadId: "owner-thread", toolCallId: "owner-call" }, requestContext } as never) as any;
  assert.equal(result.status, "running");
  const record = commands.processes.get(result.process_id);
  assert.equal(record.threadId, "owner-thread");
  assert.equal(record.runId, "owner-run");
  assert.equal(record.toolCallId, "owner-call");
  record.result.status = "failed";
  assert.equal(commands.processes.get(result.process_id).result.status, "running");
  const invalid = await commands.tools.execute_command.execute!({ command: "echo forbidden", reason: "Bad timeout", timeout: null } as never, {} as never).catch((error: unknown) => error) as any;
  assert.ok(invalid instanceof Error || invalid.error || invalid.validationErrors);
  assert.equal(commands.processes.list().length, 1);
  await commands.processes.stop(result.process_id);
  await commands.processes.stop(result.process_id);
  assert.deepEqual(events, ["cancelled"]);
  assert.equal(commands.processes.get(result.process_id).result.status, "cancelled");
  unsubscribe();
});

test("workspace_only controls explicit command cwd while the default cwd remains the workspace", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "cube-command-cwd-"));
  const root = join(parent, "workspace");
  await mkdir(root);
  const restricted = createCommandTools(root), unrestricted = createCommandTools(root, false);
  t.after(async () => {
    await Promise.all([restricted.dispose(), unrestricted.dispose()]);
    await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const args = { command: 'node -e "process.stdout.write(process.cwd())"', reason: "Check cwd", cwd: ".." };
  await assert.rejects(restricted.tools.execute_command.execute!(args as never, {} as never) as Promise<unknown>, /Permission denied/);
  const result = await unrestricted.tools.execute_command.execute!(args as never, {} as never) as any;
  assert.equal(result.cwd, parent);
  assert.equal(result.output, parent);
  const defaultCwd = await unrestricted.tools.execute_command.execute!({ ...args, cwd: undefined } as never, {} as never) as any;
  assert.equal(defaultCwd.output, root);
});

test("commands require a reason, capture bounded output and retain exit status", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cube-command-"));
  const commands = createCommandTools(root);
  t.after(async () => { await commands.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const run = (args: unknown, signal?: AbortSignal) => commands.tools.execute_command.execute!(args as never, { abortSignal: signal } as never) as Promise<any>;
  const invalid = await run({ command: "echo should-not-run" }).catch((error) => error);
  assert.ok(invalid instanceof Error || invalid.error || invalid.validationErrors);
  const result = await run({ command: 'node -e "process.stdout.write(\'hello\');process.exitCode=7"', reason: "Check capture" });
  assert.equal(result.status, "failed");
  assert.equal(result.exit_code, 7);
  assert.equal(result.output, "hello");
  assert.equal(result.cwd, root);
  assert.equal(result.reason, "Check capture");
  const large = await run({ command: 'node -e "process.stdout.write(\'x\'.repeat(300000))"', reason: "Check bound" });
  assert.equal(large.truncated, true);
  assert.ok(Buffer.byteLength(large.output) <= 256 * 1024);
  const timeout = await run({ command: 'node -e "setInterval(()=>{},1000)"', reason: "Check timeout", timeout: 0.2 });
  assert.equal(timeout.status, "timed_out");
  const abort = new AbortController();
  const pending = run({ command: 'node -e "setInterval(()=>{},1000)"', reason: "Check cancellation" }, abort.signal);
  setTimeout(() => abort.abort(), 200);
  assert.equal((await pending).status, "cancelled");
});

test("background ownership survives tool return and shutdown terminates child trees", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cube-processes-"));
  const commands = createCommandTools(root);
  t.after(async () => { await commands.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const signal = new AbortController();
  const result = await commands.tools.execute_command.execute!({
    command: 'node -e "const c=require(\'node:child_process\').spawn(process.execPath,[\'-e\',\'setInterval(()=>{},1000)\'],{stdio:\'ignore\'});console.log(c.pid);setInterval(()=>{},1000)"',
    reason: "Exercise owned process tree", background: true,
  } as never, { abortSignal: signal.signal } as never) as any;
  signal.abort();
  let output = result;
  for (let i = 0; i < 100 && !output.output.trim(); i++) {
    await delay(20);
    output = commands.processes.get(result.process_id).result;
  }
  assert.equal(output.status, "running");
  const child = Number(output.output.trim());
  assert.ok(child > 0);
  process.kill(child, 0);
  await assert.rejects(commands.processes.stop("00000000-0000-4000-8000-000000000000"), /Unknown/);
  const first = commands.dispose();
  assert.equal(commands.dispose(), first);
  await first;
  assert.throws(() => process.kill(child, 0));
});

test("one background queue enforces concurrency, cancellation and configured no-deadline", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cube-process-queue-"));
  const commands = createCommandTools(root, true, { enabled: true, concurrency: 1, timeout_ms: 0 });
  const disabled = createCommandTools(root, true, { enabled: false, concurrency: 1, timeout_ms: 0 });
  t.after(async () => {
    await Promise.all([commands.dispose(), disabled.dispose()]);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const run = (command: string, timeout?: number | null) => commands.tools.execute_command.execute!(
    { command, reason: "Exercise background queue", background: true, ...(timeout === undefined ? {} : { timeout }) } as never,
    {} as never,
  ) as Promise<any>;
  const server = await run('node -e "setInterval(()=>{},1000)"');
  assert.equal(commands.processes.get(server.process_id).timeoutMs, null);
  const queued = await run("echo QUEUED");
  assert.equal(queued.status, "pending");
  const { result: cancelled } = await commands.processes.stop(queued.process_id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.output, "");
  const next = await run("echo NEXT", 0.3);
  assert.equal(next.status, "pending");
  await delay(400);
  assert.equal(commands.processes.get(next.process_id).result.status, "pending", "Deadline starts when execution starts, not in the queue");
  await commands.processes.stop(server.process_id);
  for (let i = 0; i < 100 && commands.processes.get(next.process_id).result.status === "running"; i++) await delay(20);
  const finished = commands.processes.get(next.process_id).result;
  assert.equal(finished.status, "completed");
  assert.match(finished.output, /NEXT/);
  const rejected = await disabled.tools.execute_command.execute!({ command: "echo NO", reason: "Disabled", background: true } as never, {} as never).catch(error => error);
  assert.match(String(rejected), /disabled/);
  assert.deepEqual(disabled.processes.list(), []);
  const foreground = await disabled.tools.execute_command.execute!({ command: "echo YES", reason: "Foreground still works" } as never, {} as never) as any;
  assert.equal(foreground.status, "completed");
  await run('node -e "setInterval(()=>{},1000)"');
  const neverStart = await run("echo SHOULD_NOT_START");
  const statuses: string[] = [];
  commands.processes.subscribe(record => {
    if (record.id === neverStart.process_id) statuses.push(record.result.status);
  });
  await commands.dispose();
  assert.deepEqual(statuses, ["cancelled"], "Exit must not start queued commands during cleanup");
});

test("manage_task validates actions and forwards the native calling thread, not a model-selected thread", async () => {
  const commands = createCommandTools(tmpdir());
  try {
    assert.deepEqual(Object.keys(commands.tools), ["execute_command", "manage_task"]);
    const manage = commands.tools.manage_task;
    await assert.rejects(manage.execute!({ action: "list" } as never, {} as never), /calling thread/);
    const context = { agent: { threadId: "owner-thread" } } as never;
    await assert.rejects(manage.execute!({ action: "list" } as never, context), /unavailable/);
    const calls: unknown[] = [];
    commands.setTaskHandler(async (input, threadId) => { calls.push({ input, threadId }); return { tasks: [] }; });
    assert.deepEqual(await manage.execute!({ action: "list", threadId: "foreign" } as never, context), { tasks: [] });
    const id = "00000000-0000-4000-8000-000000000000";
    await manage.execute!({ action: "get", id } as never, context);
    await manage.execute!({ action: "kill", id } as never, context);
    assert.deepEqual(calls, [
      { input: { action: "list" }, threadId: "owner-thread" },
      { input: { action: "get", id }, threadId: "owner-thread" },
      { input: { action: "kill", id }, threadId: "owner-thread" },
    ]);
    const invalid = await manage.execute!({ action: "kill", id: "1234" } as never, context).catch(error => error) as any;
    assert.ok(invalid instanceof Error || invalid.error || invalid.validationErrors);
    assert.equal(calls.length, 3);
  } finally { await commands.dispose(); }
});
