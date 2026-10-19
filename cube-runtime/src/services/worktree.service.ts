import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HomeManager } from "@cube/workspace";

const exec = promisify(execFile);
const ownerPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type WorktreeBaseline = {
  projectRoot: string;
  commonDir: string;
  head: string;
  tree: string;
  ref: string;
};
export type ManagedWorktree = {
  path: string;
  homeRoot: string;
  ownerId: string;
  baseline: WorktreeBaseline;
};
export type ChangedFile = {
  path: string;
  status: string;
  binary: boolean;
  added: number | null;
  removed: number | null;
};

async function git(root: string, args: string[], index?: string): Promise<string> {
  const result = await exec("git", args, {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...(index ? { GIT_INDEX_FILE: index } : {}) },
  });
  return result.stdout;
}

const canonical = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
const projectKey = (root: string) =>
  createHash("sha256").update(canonical(root)).digest("hex").slice(0, 24);
const safeNewFile = (file: string) =>
  !file
    .split("/")
    .some(
      (part) =>
        /^\.env(?:\.|$)/i.test(part) ||
        /\.(?:pem|key)$/i.test(part) ||
        ["node_modules", ".git", ".cube", "build", "dist"].includes(part),
    );

async function membership(root: string, index?: string) {
  const tracked = (await git(root, ["ls-files", "-z"], index)).split("\0").filter(Boolean);
  const added = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], index))
    .split("\0")
    .filter((file) => file && safeNewFile(file));
  return { tracked, added };
}

async function fingerprint(root: string, files: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    hash.update(file).update("\0");
    try {
      const absolute = path.join(root, file);
      const stat = await lstat(absolute);
      hash.update(String(stat.mode)).update("\0");
      if (stat.isSymbolicLink()) hash.update(await readlink(absolute));
      else if (stat.isFile()) hash.update(await readFile(absolute));
      else throw new Error(`Unsupported snapshot entry: ${file}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("deleted");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function captureTree(root: string, seed: string): Promise<string> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cube-index-"));
  const index = path.join(temp, "index");
  try {
    if (await git(root, ["ls-files", "--unmerged"]))
      throw new Error("Resolve Git index conflicts before isolation");
    if (
      (await git(root, ["ls-files", "--stage", "-z"]))
        .split("\0")
        .some((line) => line.startsWith("160000 "))
    )
      throw new Error("Submodule checkouts are unsupported for subagent isolation");
    const before = await membership(root);
    const sourceIndex = await git(root, ["ls-files", "--stage", "-z"]);
    const objectFormat = (await git(root, ["rev-parse", "--show-object-format"])).trim();
    const fileMode =
      (await git(root, ["config", "--get", "core.filemode"]).catch(() => "false")).trim() ===
      "true";
    const beforeHash = await fingerprint(root, [...before.tracked, ...before.added]);
    await git(root, ["read-tree", seed], index);
    await git(root, ["add", "-u", "--", "."], index);
    // Include newly staged tracked files too: they are absent from HEAD and --others.
    const present: string[] = [];
    for (const file of [...before.tracked, ...before.added]) {
      try {
        await lstat(path.join(root, file));
        present.push(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (let i = 0; i < present.length; i += 32)
      await git(root, ["--literal-pathspecs", "add", "--", ...present.slice(i, i + 32)], index);
    const tree = (await git(root, ["write-tree"], index)).trim();
    // Verify every captured blob against the current worktree, not only a status/mtime heuristic.
    for (const entry of (await git(root, ["ls-files", "--stage", "-z"], index))
      .split("\0")
      .filter(Boolean)) {
      const separator = entry.indexOf("\t");
      const [mode, oid] = entry.slice(0, separator).split(" ");
      const file = entry.slice(separator + 1);
      const stat = await lstat(path.join(root, file));
      if (mode === "120000") {
        const content = await readlink(path.join(root, file));
        const blob = createHash(objectFormat)
          .update(`blob ${Buffer.byteLength(content)}\0`)
          .update(content)
          .digest("hex");
        if (blob !== oid) throw new Error("Source changed while capturing subagent snapshot");
      } else {
        const blob = (await git(root, ["hash-object", `--path=${file}`, "--", file])).trim();
        if (
          !stat.isFile() ||
          blob !== oid ||
          (fileMode && mode !== (stat.mode & 0o111 ? "100755" : "100644"))
        )
          throw new Error("Source changed while capturing subagent snapshot");
      }
    }
    const after = await membership(root);
    if (
      sourceIndex !== (await git(root, ["ls-files", "--stage", "-z"])) ||
      JSON.stringify(before) !== JSON.stringify(after) ||
      beforeHash !== (await fingerprint(root, [...after.tracked, ...after.added]))
    )
      throw new Error("Source changed while capturing subagent snapshot; retry when edits settle");
    return tree;
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export async function captureSubagentBaseline(
  projectRoot: string,
  ownerId: string,
): Promise<WorktreeBaseline> {
  if (!ownerPattern.test(ownerId)) throw new Error("Invalid worktree owner ID");
  const root = await realpath(projectRoot);
  const repository = await realpath((await git(root, ["rev-parse", "--show-toplevel"])).trim());
  if (canonical(root) !== canonical(repository))
    throw new Error("Isolation requires the project repository root");
  const head = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const commonDir = await realpath(
    (await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
  );
  const tree = await captureTree(root, head);
  if ((await git(root, ["rev-parse", "HEAD"])).trim() !== head)
    throw new Error("HEAD changed during snapshot capture");
  const ref = `refs/cube/subagents/${ownerId}`;
  await git(root, ["update-ref", ref, tree, "0".repeat(tree.length)]);
  return { projectRoot: root, commonDir, head, tree, ref };
}

function managedPath(homeRoot: string, baseline: WorktreeBaseline, ownerId: string) {
  if (!ownerPattern.test(ownerId)) throw new Error("Invalid worktree owner ID");
  return path.join(homeRoot, "worktrees", projectKey(baseline.projectRoot), ownerId);
}

export async function createSubagentWorktree(
  home: HomeManager,
  baseline: WorktreeBaseline,
  ownerId: string,
  prepared?: (worktree: ManagedWorktree, created: boolean) => Promise<void>,
): Promise<ManagedWorktree> {
  await mkdir(home.getRoot(), { recursive: true });
  const homeRoot = await realpath(home.getRoot());
  const target = managedPath(homeRoot, baseline, ownerId);
  await mkdir(path.dirname(target), { recursive: true });
  if (canonical(await realpath(path.dirname(target))) !== canonical(path.dirname(target)))
    throw new Error("Managed worktree parent may not redirect outside Cube home");
  const worktree = { path: target, homeRoot, ownerId, baseline };
  // Persist the exact ownership before Git can create a checkout, including partial failures.
  await prepared?.(worktree, false);
  await git(baseline.projectRoot, ["worktree", "add", "--detach", "--", target, baseline.head]);
  await prepared?.(worktree, true);
  // The detached child owns this index; main index and HEAD are never touched.
  await git(target, ["read-tree", "--reset", "-u", baseline.tree]);
  return worktree;
}

async function assertOwned(worktree: ManagedWorktree) {
  const expected = managedPath(worktree.homeRoot, worktree.baseline, worktree.ownerId);
  if (
    canonical(path.resolve(worktree.path)) !== canonical(expected) ||
    canonical(await realpath(worktree.path)) !== canonical(expected)
  )
    throw new Error("Invalid managed worktree ownership");
  const common = await realpath(
    (await git(worktree.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
  );
  const listed = (
    await git(worktree.baseline.projectRoot, ["worktree", "list", "--porcelain", "-z"])
  )
    .split("\0")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice(9)));
  if (
    canonical(common) !== canonical(worktree.baseline.commonDir) ||
    !listed.some((root) => canonical(root) === canonical(expected))
  )
    throw new Error("Git worktree ownership mismatch");
  if (
    (await git(worktree.path, ["rev-parse", worktree.baseline.ref])).trim() !==
    worktree.baseline.tree
  )
    throw new Error("Owned snapshot retention ref mismatch");
}

export async function readSubagentChanges(
  worktree: ManagedWorktree,
): Promise<{ revision: string; files: ChangedFile[]; diff: string }> {
  await assertOwned(worktree);
  const tree = await captureTree(worktree.path, worktree.baseline.tree);
  const args = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    worktree.baseline.tree,
    tree,
  ];
  const stats = (await git(worktree.path, [...args, "--numstat", "-z"]))
    .split("\0")
    .filter(Boolean);
  const statuses = (await git(worktree.path, [...args, "--name-status", "-z"]))
    .split("\0")
    .filter(Boolean);
  const files = stats.map((line, i): ChangedFile => {
    const first = line.indexOf("\t"),
      second = line.indexOf("\t", first + 1);
    const added = line.slice(0, first),
      removed = line.slice(first + 1, second);
    return {
      path: line.slice(second + 1),
      status: statuses[i * 2]!,
      binary: added === "-",
      added: added === "-" ? null : Number(added),
      removed: removed === "-" ? null : Number(removed),
    };
  });
  return { revision: tree, files, diff: await git(worktree.path, [...args, "--patch"]) };
}

export async function removeSubagentWorktree(
  worktree: ManagedWorktree,
  releaseBaseline: boolean,
): Promise<void> {
  const expected = managedPath(worktree.homeRoot, worktree.baseline, worktree.ownerId);
  if (canonical(path.resolve(worktree.path)) !== canonical(expected))
    throw new Error("Invalid managed worktree ownership");
  let exists = true;
  try {
    await realpath(worktree.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  // Only called after the service has checked all associated turns/processes and human confirmation.
  if (exists) {
    await assertOwned(worktree);
    await git(worktree.baseline.projectRoot, [
      "worktree",
      "remove",
      "--force",
      "--",
      worktree.path,
    ]);
  } else {
    const listed = await git(worktree.baseline.projectRoot, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    if (
      listed
        .split("\0")
        .some(
          (line) =>
            line.startsWith("worktree ") &&
            canonical(path.resolve(line.slice(9))) === canonical(expected),
        )
    )
      throw new Error(
        "Managed checkout is missing but Git still registers it; repair it before removal",
      );
  }
  if (releaseBaseline) await releaseSubagentBaseline(worktree.baseline);
}

export async function releaseSubagentBaseline(baseline: WorktreeBaseline): Promise<void> {
  if (
    !/^refs\/cube\/subagents\/[0-9a-f-]+$/.test(baseline.ref) ||
    !ownerPattern.test(baseline.ref.split("/").at(-1)!)
  )
    throw new Error("Invalid owned baseline ref");
  const common = await realpath(
    (
      await git(baseline.projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).trim(),
  );
  if (
    canonical(common) !== canonical(baseline.commonDir) ||
    (await git(baseline.projectRoot, ["rev-parse", "--verify", baseline.ref])).trim() !==
      baseline.tree
  )
    throw new Error("Owned snapshot retention ref mismatch");
  await git(baseline.projectRoot, ["update-ref", "-d", baseline.ref, baseline.tree]);
}
