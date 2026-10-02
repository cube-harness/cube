import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import * as files from "../src/store/atomic-write.js";

const fixture = async (context: TestContext) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cube-file-lock-"));
  context.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return path.join(directory, "memory.json");
};

test("file lock protects the read as well as the write from lost updates", async (context) => {
  const target = await fixture(context);
  await files.atomicWriteFile(target, "0");
  await Promise.all(Array.from({ length: 8 }, () => files.withFileLock(target, async () => {
    const previous = Number(await readFile(target, "utf8"));
    await delay(5);
    await files.atomicWriteFile(target, String(previous + 1));
  })));
  assert.equal(await readFile(target, "utf8"), "8");
  const worker = `
    import { readFile } from "node:fs/promises";
    import { setTimeout as delay } from "node:timers/promises";
    import { withFileLock, atomicWriteFile } from ${JSON.stringify(
      new URL("../src/store/atomic-write.ts", import.meta.url).href,
    )};
    const target = process.argv[1];
    for (let i = 0; i < 4; i++) {
      await withFileLock(target, async () => {
        const previous = Number(await readFile(target, "utf8"));
        await delay(20);
        await atomicWriteFile(target, String(previous + 1));
      });
    }
  `;
  await Promise.all([0, 1].map(() => promisify(execFile)(process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", worker, target], { timeout: 10_000 })));
  assert.equal(await readFile(target, "utf8"), "16");
  assert.deepEqual(await readdir(path.dirname(target)), ["memory.json"]);
});

test("file lock releases after a failed update without changing the target", async (context) => {
  const target = await fixture(context);
  await files.atomicWriteFile(target, "stable");
  const failure = new Error("failed merge");
  await assert.rejects(files.withFileLock(target, async () => { throw failure; }),
    (error) => error === failure);
  assert.equal(await readFile(target, "utf8"), "stable");
  await files.withFileLock(target, () => files.atomicWriteFile(target, "next"));
  assert.equal(await readFile(target, "utf8"), "next");
  assert.deepEqual(await readdir(path.dirname(target)), ["memory.json"]);
});

test("waiting writers time out or cancel without deleting another owner's lock", async (context) => {
  const target = await fixture(context);
  await files.atomicWriteFile(target, "stable");
  await writeFile(`${target}.lock`, "another owner", "utf8");
  const mustNotRun = async () => { assert.fail("a waiting writer acquired an existing lock"); };
  await assert.rejects(files.withFileLock(target, mustNotRun, { timeoutMs: 20 }), /locked/i);
  const controller = new AbortController();
  const pending = files.withFileLock(target, mustNotRun, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof Error && error.name === "AbortError");
  assert.equal(await readFile(`${target}.lock`, "utf8"), "another owner");
  assert.equal(await readFile(target, "utf8"), "stable");
});
