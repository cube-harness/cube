import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandOutputStore } from "../src/tools/command-output.js";
import { createCommandTools } from "../src/tools/command.tools.js";

test("spill and byte pages preserve line overflow, split UTF-8 and very long lines", async t => {
  const root = await mkdtemp(join(tmpdir(), "cube-output-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = new CommandOutputStore(join(root, "logs"));
  const output = store.create("command", "thread", { max_bytes: 256 * 1024, max_lines: 200 });
  await output.append(Buffer.from("small"));
  await assert.rejects(access(join(root, "logs")), /ENOENT/);
  const full = "small" + "line\n".repeat(250) + "Tiếng Việt 😀".repeat(18000);
  const bytes = Buffer.from(full.slice(5));
  for (let offset = 0; offset < bytes.length; offset += 12345) await output.append(bytes.subarray(offset, offset + 12345));
  await output.finish();
  const preview = output.preview(200);
  assert.equal(preview.truncated, true); assert.ok(preview.read_more);
  assert.ok(!preview.output.includes("�"));
  output.release();
  let cursor: number | undefined = 0, recovered = "";
  while (cursor !== undefined) {
    const page = await store.read("command", cursor, 50);
    assert.ok(Buffer.byteLength(page.output) <= 16384); assert.ok(!page.output.includes("�"));
    assert.equal(page.output_complete, true);
    assert.ok(page.next_cursor === undefined || page.next_cursor > cursor);
    recovered += page.output; cursor = page.next_cursor;
  }
  assert.equal(recovered, full);
  assert.equal(await readFile(join(root, "logs", "thread", "command.log"), "utf8"), full);
  await store.dispose(); await assert.rejects(access(join(root, "logs")), /ENOENT/);
});

test("running EOF, bad cursors and substituted log identity are not trusted", async t => {
  const root = await mkdtemp(join(tmpdir(), "cube-output-cursors-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = new CommandOutputStore(root);
  const output = store.create("command", "thread", { max_bytes: 4, max_lines: 1 });
  await output.append(Buffer.from("😀one"));
  const page = await store.read("command", 0);
  assert.equal(page.output_complete, false); assert.equal(page.next_cursor, 7);
  const eof = await store.read("command", 7); assert.equal(eof.output, ""); assert.equal(eof.output_complete, false);
  await assert.rejects(store.read("command", 1), /UTF-8/);
  await assert.rejects(store.read("command", 100), /exceeds/);
  await assert.rejects(store.read("command", -1), /Invalid/);
  await assert.rejects(store.read("other", 0), /another or expired/);
  assert.throws(() => store.create("../escape", "thread", { max_bytes: 4, max_lines: 1 }), /owner/);
  await output.finish();
  const path = join(root, "thread", "command.log");
  await rename(path, path + ".original"); await writeFile(path, "NOT_OWNED");
  await assert.rejects(store.read("command", 0), /source changed/);
  await store.dispose(); assert.equal(await readFile(path, "utf8"), "NOT_OWNED");
});

test("IO failure keeps a bounded preview and shared cleanup removes only owned files", async t => {
  const root = await mkdtemp(join(tmpdir(), "cube-output-owners-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(join(root, "blocked"), "not a directory");
  const broken = new CommandOutputStore(join(root, "blocked", "logs"));
  const failed = broken.create("command", "thread", { max_bytes: 4, max_lines: 1 });
  await failed.append(Buffer.from("preserve this output")); await failed.finish();
  assert.equal(failed.preview(1).log_available, false); assert.match(failed.preview(1).output_warning!, /unavailable/);
  const commands = createCommandTools(root, true, undefined, root, {
    cacheDir: join(root, "blocked", "commands"), policy: { max_bytes: 4, max_lines: 1 },
  });
  try {
    const result = await commands.tools.execute_command.execute!({ command: "echo OUTPUT_OK", reason: "Verify IO failure does not change command success" } as never, {} as never) as any;
    assert.equal(result.exit_code, 0); assert.equal(result.status, "completed");
    assert.equal(result.log_available, false); assert.equal(result.output_complete, false); assert.ok(result.output_warning);
  } finally { await commands.dispose(); }
  const left = new CommandOutputStore(join(root, "shared")), right = new CommandOutputStore(join(root, "shared"));
  for (const [store, id] of [[left, "left"], [right, "right"]] as const) {
    const output = store.create(id, "thread", { max_bytes: 4, max_lines: 1 });
    await output.append(Buffer.from(id + " output")); await output.finish(); output.release();
  }
  await left.dispose(); assert.equal((await right.read("right", 0)).output, "right output");
  await right.dispose(); await assert.rejects(access(join(root, "shared")), /ENOENT/);
});

test("a substituted cache directory never writes command data through a link", async t => {
  const root = await mkdtemp(join(tmpdir(), "cube-output-link-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const target = join(root, "outside"); await mkdir(target);
  await symlink(target, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  const store = new CommandOutputStore(join(root, "linked"));
  const output = store.create("command", "thread", { max_bytes: 4, max_lines: 1 });
  await output.append(Buffer.from("command data")); await output.finish();
  assert.equal(output.preview(1).log_available, false);
  assert.match(output.preview(1).output_warning!, /Unsafe/);
  await assert.rejects(access(join(target, "thread")), /ENOENT/);
  await store.dispose();
});

test("foreground logs survive registry eviction and child-tool disposal until runtime disposal", { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "cube-output-registry-"));
  const store = new CommandOutputStore(join(root, "logs"));
  const commands = createCommandTools(root, true, undefined, root, { store, policy: { max_bytes: 16, max_lines: 2 } });
  t.after(async () => { await commands.dispose(); await store.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const run = (command: string) => commands.tools.execute_command.execute!({ command, reason: "Check preserved foreground output" } as never,
    { agent: { threadId: "owner" } } as never) as Promise<any>;
  const first = await run("echo PRESERVED_FOREGROUND_OUTPUT");
  assert.equal(first.exit_code, 0); assert.ok(first.read_more);
  for (let batch = 0; batch < 20; batch++) await Promise.all(Array.from({ length: 5 }, () => run("echo ok")));
  assert.equal(commands.processes.list().length, 100);
  assert.equal(commands.processes.get(first.process_id).threadId, "owner");
  assert.match((await commands.processes.readOutput!(first.process_id, 0)).output, /PRESERVED_FOREGROUND_OUTPUT/);
  await commands.dispose(); assert.match((await store.read(first.process_id, 0)).output, /PRESERVED_FOREGROUND_OUTPUT/);
});

test("background output spills before the 16 KiB publication preview discards its prefix", { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "cube-output-background-"));
  const commands = createCommandTools(root);
  t.after(async () => { await commands.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const completed = new Promise<void>(resolve => commands.processes.subscribe(record => { if (record.completedAt) resolve(); }));
  const result = await commands.tools.execute_command.execute!({
    command: 'node -e "process.stdout.write(\'x\'.repeat(32000))"', reason: "Verify background preservation", background: true,
  } as never, { agent: { threadId: "owner" } } as never) as any;
  await completed;
  const final = commands.processes.get(result.process_id).result;
  assert.ok(final.truncated && final.read_more && final.log_available);
  assert.ok(Buffer.byteLength(final.output) <= 16384);
  const first = await commands.processes.readOutput!(result.process_id, 0);
  const last = await commands.processes.readOutput!(result.process_id, first.next_cursor);
  assert.equal(first.output + last.output, "x".repeat(32000));
});
