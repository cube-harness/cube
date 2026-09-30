import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, readdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { measure, quick, report } from "./harness.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const windows = process.platform === "win32";
const target = windows ? "windows" : `${process.platform}-${process.arch}`;
const filename = windows ? "cube-windows-x64.zip" : `cube-${target}.tar.gz`;
const archiveArgument = process.argv.find((argument) => argument.startsWith("--archive="));
const archive = path.resolve(archiveArgument?.slice("--archive=".length) ?? path.join(root, "build", target, filename));
const preload = new URL("./harness.mjs", import.meta.url).href;
const archiveInfo = await stat(archive).catch((cause) => {
  throw new Error(`Archive unavailable: ${archive}. Build it with pnpm package:app first.`, { cause });
});
const scratch = await mkdtemp(path.join(os.tmpdir(), "cube-package-bench-"));
let extraction;
let inventory;
let index = 0;

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout || `Process exited with ${result.status}`);
  return result.stdout;
}

async function inspect(directory) {
  const result = { files: 0, directories: 0, bytes: 0 };
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await inspect(location);
      result.files += child.files;
      result.directories += child.directories + 1;
      result.bytes += child.bytes;
    } else {
      result.files++;
      result.bytes += (await lstat(location)).size;
    }
  }
  return result;
}

try {
  await measure("package.extract", () => run(windows ? "tar.exe" : "tar",
    windows ? ["-xf", archive, "-C", extraction] : ["-xzf", archive, "-C", extraction], scratch),
  async () => {
    inventory = await inspect(extraction);
    assert.ok(inventory.files > 0);
    assert.ok((await stat(path.join(extraction, "runtime", windows ? "node.exe" : "node"))).isFile());
  }, { iterations: quick ? 1 : 3, warmup: 0, prepare: async () => {
    extraction = await mkdtemp(path.join(scratch, `extract-${index++}-`));
  } });
  const runtime = path.join(extraction, "runtime", windows ? "node.exe" : "node");
  const app = path.join(extraction, "app");
  // The CLI bundle starts its TUI on import. Parse it without executing the app.
  await measure("package.syntax.main", () => run(runtime, [
    "--import", preload, "--check", path.join(app, "dist", "main.js"),
  ], app), (output) => assert.equal(output, ""), { iterations: quick ? 1 : 3, warmup: 1 });
  await measure("package.smoke.local", () => run(runtime, [
    "--import", preload, path.join(app, "package-smoke.mjs"),
  ], extraction), (output) => assert.match(output, /package-smoke:/), { iterations: quick ? 1 : 3, warmup: 1 });
  report({
    suite: "package", archive, archiveBytes: archiveInfo.size,
    archiveModifiedAt: archiveInfo.mtime.toISOString(), unpacked: inventory,
    exclusions: ["provider/model latency", "full interactive application boot", "unmeasured historical baselines"],
  });
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
