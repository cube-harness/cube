import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HomeManager } from "@cube/workspace";
import { captureSubagentBaseline, createSubagentWorktree, readSubagentChanges,
  removeSubagentWorktree } from "../../src/services/worktree.service.js";

const exec = promisify(execFile);
test("isolated dirty snapshots preserve main index and compare child changes to captured content", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cube-worktree-"));
  const root = path.join(temp, "project with spaces Việt");
  const home = new HomeManager({ cubeHome: path.join(temp, "home") });
  const git = (...args: string[]) => exec("git", args, { cwd: root });
  try {
    await mkdir(root);
    await git("init");
    await git("config", "core.autocrlf", "false");
    await git("config", "user.name", "Cube Test");
    await git("config", "user.email", "cube@example.invalid");
    await writeFile(path.join(root, ".gitignore"), "ignored/\n");
    await writeFile(path.join(root, "source.txt"), "initial\n");
    await writeFile(path.join(root, "deleted.txt"), "delete me\n");
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(root, ".env.tracked"), "tracked fixture\n");
    await git("add", ".");
    await git("commit", "-m", "fixture");
    await writeFile(path.join(root, "source.txt"), "staged\n");
    await git("add", "source.txt");
    await writeFile(path.join(root, "source.txt"), "unstaged\n");
    await rm(path.join(root, "deleted.txt"));
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 5, 6]));
    await writeFile(path.join(root, "-literal.txt"), "new\n");
    await writeFile(path.join(root, "new-staged.txt"), "staged new\n");
    await git("add", "new-staged.txt");
    await writeFile(path.join(root, ".env.new"), "untracked secret fixture");
    await mkdir(path.join(root, "ignored"));
    await writeFile(path.join(root, "ignored", "cache.txt"), "ignored");
    const indexBefore = await readFile(path.join(root, ".git", "index"));
    const head = (await git("rev-parse", "HEAD")).stdout;
    const firstId = randomUUID();
    const baseline = await captureSubagentBaseline(root, firstId);
    const first = await createSubagentWorktree(home, baseline, firstId);
    const second = await createSubagentWorktree(home, baseline, randomUUID());
    assert.equal(await readFile(path.join(first.path, "source.txt"), "utf8"), "unstaged\n");
    assert.equal(await readFile(path.join(second.path, "-literal.txt"), "utf8"), "new\n");
    assert.equal(await readFile(path.join(first.path, "new-staged.txt"), "utf8"), "staged new\n");
    assert.deepEqual(await readFile(path.join(first.path, "binary.bin")), Buffer.from([0, 5, 6]));
    await assert.rejects(readFile(path.join(first.path, "deleted.txt")), /ENOENT/);
    await assert.rejects(readFile(path.join(first.path, ".env.new")), /ENOENT/);
    await assert.rejects(readFile(path.join(first.path, "ignored", "cache.txt")), /ENOENT/);
    assert.equal(await readFile(path.join(first.path, ".env.tracked"), "utf8"), "tracked fixture\n");
    assert.deepEqual((await readSubagentChanges(first)).files, []);
    await writeFile(path.join(first.path, "source.txt"), "child edit\n");
    await writeFile(path.join(first.path, "new-child.txt"), "child new\n");
    await writeFile(path.join(first.path, "child-staged.txt"), "child staged\n");
    await exec("git", ["add", "child-staged.txt"], { cwd: first.path });
    const changes = await readSubagentChanges(first);
    assert.deepEqual(changes.files.map(file => file.path).sort(), ["child-staged.txt", "new-child.txt", "source.txt"]);
    assert.match(changes.diff, /-unstaged/);
    assert.doesNotMatch(changes.diff, /-initial/);
    await assert.rejects(removeSubagentWorktree({ ...first, path: root }, false), /ownership|managed/i);
    const patch = path.join(temp, "changes.patch");
    await writeFile(patch, changes.diff);
    await writeFile(path.join(root, "source.txt"), "concurrent main edit\n");
    await assert.rejects(git("apply", "--check", patch));
    assert.deepEqual(await readFile(path.join(root, ".git", "index")), indexBefore);
    assert.equal((await git("rev-parse", "HEAD")).stdout, head);
    await removeSubagentWorktree(first, false);
    await removeSubagentWorktree(second, true);
    await assert.rejects(readFile(path.join(second.path, "source.txt")), /ENOENT/);
    await assert.rejects(git("rev-parse", "--verify", baseline.ref));
  } finally { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("unborn and non-Git projects refuse worktree isolation explicitly", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cube-no-head-"));
  try {
    await assert.rejects(captureSubagentBaseline(temp, randomUUID()));
    await exec("git", ["init"], { cwd: temp });
    await assert.rejects(captureSubagentBaseline(temp, randomUUID()));
  } finally { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("partial checkout preparation retains exact ownership and remains explicitly removable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-partial-worktree-"));
  const project = path.join(root, "project");
  const home = new HomeManager({ cubeHome: path.join(root, "home") });
  const git = (...args: string[]) => exec("git", args, { cwd: project });
  try {
    await mkdir(project); await git("init"); await git("config", "user.name", "Cube Test");
    await git("config", "user.email", "cube@example.invalid");
    await writeFile(path.join(project, "fixture.txt"), "fixture\n");
    await git("add", "."); await git("commit", "-m", "fixture");
    for (const failAfterCreation of [false, true]) {
      const id = randomUUID();
      const baseline = await captureSubagentBaseline(project, id);
      let owned: Parameters<typeof removeSubagentWorktree>[0] | undefined;
      await assert.rejects(createSubagentWorktree(home, baseline, id, async (checkout, created) => {
        owned = checkout;
        if (created === failAfterCreation) throw new Error("Preparation interrupted");
      }), /Preparation interrupted/);
      assert.ok(owned);
      await removeSubagentWorktree(owned, true);
      await assert.rejects(git("rev-parse", "--verify", baseline.ref));
      assert.equal(await readFile(path.join(project, "fixture.txt"), "utf8"), "fixture\n");
    }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("snapshot rejects a source that changes during capture without retaining a baseline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-snapshot-race-"));
  const git = (...args: string[]) => exec("git", args, { cwd: root });
  let writing = true;
  let writes: Promise<void> | undefined;
  const id = randomUUID();
  try {
    await git("init"); await git("config", "user.name", "Cube Test");
    await git("config", "user.email", "cube@example.invalid");
    const file = path.join(root, "changing.txt");
    await writeFile(file, "initial\n"); await git("add", "."); await git("commit", "-m", "fixture");
    writes = (async () => { let value = 0; while (writing) await writeFile(file, String(++value) + "\n"); })();
    await assert.rejects(captureSubagentBaseline(root, id), /changed|unable|could not|invalid/i);
    await assert.rejects(git("rev-parse", "--verify", `refs/cube/subagents/${id}`));
  } finally {
    writing = false; await writes;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
