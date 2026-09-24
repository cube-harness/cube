import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Build this package on Windows x64.");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.env.npm_execpath;
if (!pnpm || !/\.(?:c?js|mjs)$/i.test(pnpm)) {
  throw new Error("Run this script with pnpm package:windows.");
}
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${result.status}`);
}

run(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--build", "--force"]);
await cp(path.join(root, "cube-workspace/src/template"), path.join(root, "cube-workspace/dist/template"), { recursive: true });
await cp(path.join(root, "cube-agent/src/prompts/initialize.md"), path.join(root, "cube-agent/dist/prompts/initialize.md"));

const output = path.join(root, "build/windows");
await mkdir(output, { recursive: true });
// Fresh directory for each build: never delete or overwrite a previous installation.
const stage = await mkdtemp(path.join(output, "stage-"));
const app = path.join(stage, "app");
run(process.execPath, [pnpm, "--filter", "@cube/tui", "deploy", "--prod", "--ignore-scripts", "--config.inject-workspace-packages=true", "--config.node-linker=hoisted", "--config.enable-global-virtual-store=false", app]);

// A ZIP must not contain pnpm links back to a checkout/store.
async function checkLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Non-portable link in deployment: ${target}`);
    if (entry.isDirectory()) await checkLinks(target);
  }
}
await checkLinks(app);
await mkdir(path.join(stage, "runtime"));
await cp(process.execPath, path.join(stage, "runtime/node.exe"));
const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(30_000) });
if (!license.ok) throw new Error(`Cannot fetch Node license: HTTP ${license.status}`);
await writeFile(path.join(stage, "runtime/LICENSE"), await license.text());
await cp(path.join(root, "scripts/cube.cmd"), path.join(stage, "cube.cmd"));
await cp(path.join(root, "scripts/windows-smoke.mjs"), path.join(stage, "app/windows-smoke.mjs"));

// Exercise the deployed graph, templates, SQLite and tools in a temporary workspace.
run(path.join(stage, "runtime/node.exe"), [path.join(stage, "app/windows-smoke.mjs")], stage);
const archive = path.join(output, "cube-windows-x64.zip");
run("tar.exe", ["-a", "-c", "-f", archive, "-C", stage, "."]);
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const sha256 = hash.digest("hex");
const { version } = JSON.parse(await readFile(path.join(root, "cube-tui/package.json"), "utf8"));
await writeFile(path.join(output, "latest.json"), JSON.stringify({ version, platform: "win32-x64", file: "cube-windows-x64.zip", sha256 }, null, 2) + "\n");
await writeFile(`${archive}.sha256`, sha256 + "\n");
await cp(path.join(root, "scripts/install.ps1"), path.join(output, "install.ps1"));
console.log(`Windows package: ${archive}\nSHA256: ${sha256}\nUnpacked: ${stage}`);
