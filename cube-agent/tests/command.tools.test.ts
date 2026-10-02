import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCommandTools } from "../src/tools/command.tools.js";

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
    output = await commands.tools.get_process.execute!({ process_id: result.process_id } as never, {} as never);
  }
  assert.equal(output.status, "running");
  const child = Number(output.output.trim());
  assert.ok(child > 0);
  process.kill(child, 0);
  await assert.rejects(commands.tools.kill_process.execute!({ process_id: "00000000-0000-4000-8000-000000000000" } as never, {} as never), /Unknown/);
  const first = commands.dispose();
  assert.equal(commands.dispose(), first);
  await first;
  assert.throws(() => process.kill(child, 0));
});
