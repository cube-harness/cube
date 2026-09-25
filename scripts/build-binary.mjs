import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = `${process.platform}-${process.arch}`;
const windows = process.platform === "win32";
if (!["win32-x64", "linux-x64", "darwin-arm64", "darwin-x64"].includes(target)) {
  throw new Error(`Unsupported build host: ${target}. Build natively on a supported target.`);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
await cp(path.join(root, "cube-agent/src/prompts/initialize.md"), path.join(root, "cube-agent/dist/prompts/initialize.md"));

const output = path.join(root, "build", windows ? "windows" : target);
await mkdir(output, { recursive: true });
// Fresh directory for each build: never delete or overwrite a previous installation.
const stage = await mkdtemp(path.join(output, "stage-"));
const app = path.join(stage, "app");
run(process.execPath, [pnpm, "--filter", "@cube/tui", "deploy", "--prod", "--ignore-scripts", "--config.inject-workspace-packages=true", "--config.node-linker=hoisted", "--config.enable-global-virtual-store=false", app]);

// Unix executables use relative symlinks; none may escape the deployed app.
async function checkLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const relative = path.relative(app, await realpath(target));
      if (windows || path.isAbsolute(await readlink(target)) || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Non-portable link in deployment: ${target}`);
      }
    }
    if (entry.isDirectory()) await checkLinks(target);
  }
}
await checkLinks(app);
await mkdir(path.join(stage, "runtime"));
const node = path.join(stage, "runtime", windows ? "node.exe" : "node");
await cp(process.execPath, node);
if (!windows) await chmod(node, 0o755);
const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(30_000) });
if (!license.ok) throw new Error(`Cannot fetch Node license: HTTP ${license.status}`);
await writeFile(path.join(stage, "runtime/LICENSE"), await license.text());
const launcher = windows ? "cube.cmd" : "cube";
await cp(path.join(root, `scripts/${launcher}`), path.join(stage, launcher));
if (!windows) await chmod(path.join(stage, launcher), 0o755);
await cp(path.join(root, "scripts/package-smoke.mjs"), path.join(stage, "app/package-smoke.mjs"));

// Exercise the deployed graph, templates, SQLite and tools in a temporary workspace.
run(node, [path.join(stage, "app/package-smoke.mjs")], stage);
const filename = windows ? "cube-windows-x64.zip" : `cube-${target}.tar.gz`;
const archive = path.join(output, filename);
run(windows ? "tar.exe" : "tar", windows
  ? ["-a", "-c", "-f", archive, "-C", stage, "."]
  : ["-czf", archive, "-C", stage, "."]);
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const sha256 = hash.digest("hex");
const { version } = JSON.parse(await readFile(path.join(root, "cube-tui/package.json"), "utf8"));
await writeFile(path.join(output, "latest.json"), JSON.stringify({ version, platform: target, file: filename, sha256 }, null, 2) + "\n");
await writeFile(`${archive}.sha256`, sha256 + "\n");
const installer = windows ? "install.ps1" : "install.sh";
await cp(path.join(root, `scripts/${installer}`), path.join(output, installer));
if (!windows) {
  // Shell-readable pointer: installing must not require Node, Python or jq.
  await writeFile(path.join(output, `latest-${target}.txt`), `${sha256} releases/${sha256.slice(0, 16)}/${filename}\n`);
}
console.log(`${target} package: ${archive}\nSHA256: ${sha256}\nUnpacked: ${stage}`);
