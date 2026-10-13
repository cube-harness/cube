import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleApp } from "./bundle.mjs";

const target = `${process.platform}-${process.arch}`;
const windows = process.platform === "win32";
if (!["win32-x64", "linux-x64", "darwin-arm64", "darwin-x64"].includes(target)) {
  throw new Error(`Unsupported build host: ${target}. Build natively on a supported target.`);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Set a valid release version in the root package.json before packaging.");
}
const pnpm = process.env.npm_execpath;
if (!pnpm || !/\.(?:c?js|mjs)$/i.test(pnpm)) {
  throw new Error("Run this script with pnpm package:app.");
}
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${result.status}`);
}

run(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--build", "--force"]);
await cp(path.join(root, "cube-workspace/src/template"), path.join(root, "cube-workspace/dist/template"), { recursive: true });

const output = path.join(root, "build", windows ? "windows" : target);
await mkdir(output, { recursive: true });
// Fresh directory for each build: never delete or overwrite a previous installation.
const stage = await mkdtemp(path.join(output, "stage-"));

// Bundle entire application graph and native dependencies into stage/app
await bundleApp(stage, target);
await mkdir(path.join(stage, "runtime"));
const node = path.join(stage, "runtime", windows ? "node.exe" : "node");
await cp(process.execPath, node);
if (!windows) await chmod(node, 0o755);
const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(30_000) });
if (!license.ok) throw new Error(`Cannot fetch Node license: HTTP ${license.status}`);
await writeFile(path.join(stage, "runtime/LICENSE"), await license.text());
// Pin official ripgrep archives and verify them before extracting executable code.
const rgVersion = "15.2.0";
const rgTargets = {
  "win32-x64": ["x86_64-pc-windows-msvc.zip", "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5"],
  "linux-x64": ["x86_64-unknown-linux-musl.tar.gz", "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c"],
  "darwin-arm64": ["aarch64-apple-darwin.tar.gz", "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4"],
  "darwin-x64": ["x86_64-apple-darwin.tar.gz", "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1"],
};
const [rgTarget, rgChecksum] = rgTargets[target];
const rgArchive = `ripgrep-${rgVersion}-${rgTarget}`;
console.log(`[bundle] Installing ripgrep ${rgVersion} for ${target}...`);
const rgDownload = await fetch(`https://github.com/BurntSushi/ripgrep/releases/download/${rgVersion}/${rgArchive}`, {
  signal: AbortSignal.timeout(60_000),
});
if (!rgDownload.ok) throw new Error(`Cannot fetch ripgrep: HTTP ${rgDownload.status}`);
const rgBytes = Buffer.from(await rgDownload.arrayBuffer());
if (createHash("sha256").update(rgBytes).digest("hex") !== rgChecksum)
  throw new Error("ripgrep archive checksum mismatch");
const rgScratch = await realpath(await mkdtemp(path.join(stage, "ripgrep-")));
if (path.dirname(rgScratch) !== await realpath(stage) || !path.basename(rgScratch).startsWith("ripgrep-"))
  throw new Error("Unsafe ripgrep extraction target");
try {
  const downloaded = path.join(rgScratch, rgArchive);
  await writeFile(downloaded, rgBytes);
  run(windows ? "tar.exe" : "tar", ["-xf", downloaded, "-C", rgScratch]);
  const extracted = path.join(rgScratch, rgArchive.replace(/\.(?:zip|tar\.gz)$/, ""));
  const rgBinary = windows ? "rg.exe" : "rg";
  const installed = path.join(stage, "runtime", rgBinary);
  await cp(path.join(extracted, rgBinary), installed);
  if (!windows) await chmod(installed, 0o755);
  for (const name of ["COPYING", "LICENSE-MIT", "UNLICENSE"])
    await cp(path.join(extracted, name), path.join(stage, "runtime", `ripgrep-${name}`));
} finally {
  await rm(rgScratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
const launcher = windows ? "cube.cmd" : "cube";
await cp(path.join(root, `scripts/${launcher}`), path.join(stage, launcher));
if (!windows) await chmod(path.join(stage, launcher), 0o755);

// Exercise the deployed graph, templates, SQLite and tools in a temporary workspace.
const smokeRoot = await realpath(await mkdtemp(path.join(stage, "smoke-")));
if (path.dirname(smokeRoot) !== await realpath(stage) || !path.basename(smokeRoot).startsWith("smoke-"))
  throw new Error("Unsafe package-smoke cleanup target");
try {
  run(node, [path.join(stage, "app/package-smoke.mjs"), smokeRoot], stage);
} finally {
  // Windows native SQLite handles can survive close() until this child exits.
  await rm(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
const filename = windows ? "cube-windows-x64.zip" : `cube-${target}.tar.gz`;
const archive = path.join(output, filename);
run(windows ? "tar.exe" : "tar", windows
  ? ["-a", "-c", "-f", archive, "-C", stage, "."]
  : ["-czf", archive, "-C", stage, "."]);
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const sha256 = hash.digest("hex");
const file = `releases/${version}/${filename}`;
await writeFile(path.join(output, "latest.json"), JSON.stringify({ version, platform: target, file, sha256 }, null, 2) + "\n");
await writeFile(`${archive}.sha256`, sha256 + "\n");
const installer = windows ? "install.ps1" : "install.sh";
await cp(path.join(root, `scripts/${installer}`), path.join(output, installer));
if (!windows) {
  // Shell-readable pointer: installing must not require Node, Python or jq.
  await writeFile(path.join(output, `latest-${target}.txt`), `${sha256} ${file}\n`);
}
console.log(`${target} package: ${archive}\nSHA256: ${sha256}\nUnpacked: ${stage}`);
