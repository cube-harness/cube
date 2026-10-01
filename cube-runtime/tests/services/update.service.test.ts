import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCubeUpdate, prepareCubeUpdate } from "../../src/services/update.service.js";

const payload = Buffer.from("verified package");
const sha256 = createHash("sha256").update(payload).digest("hex");
const currentBuild = "0123456789abcdef";
const fixture = async (target = "win32-x64") => {
  const root = await mkdtemp(path.join(tmpdir(), "cube-update-"));
  const version = path.join(root, "versions", currentBuild);
  const execPath = path.join(version, "runtime", target.startsWith("win32") ? "node.exe" : "node");
  const launcher = path.join(root, "bin", target.startsWith("win32") ? "cube.cmd" : "cube");
  await mkdir(path.dirname(execPath), { recursive: true });
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(execPath, "installed runtime");
  await writeFile(launcher, "installed launcher");
  return { root, execPath, launcher, platform: target.split("-")[0], arch: target.split("-")[1] };
};
const manifestFetch = (target: string, hash = sha256, file?: string) => {
  const windows = target === "win32-x64";
  const archive = windows ? "cube-windows-x64.zip" : `cube-${target}.tar.gz`;
  const remoteFile = file ?? `releases/1.0.0/${archive}`;
  return (async (url: string | URL | Request, options: RequestInit) => {
    assert.match(String(url), new RegExp(windows ? "/latest.json$" : `/latest-${target}.txt$`));
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal);
    return new Response(windows ? JSON.stringify({ version: "1.0.0", platform: target, sha256: hash, file: remoteFile }) : `${hash} ${remoteFile}\n`);
  }) as typeof fetch;
};

test("startup accepts version-named releases while comparing the installed checksum", async () => {
  for (const target of ["win32-x64", "linux-x64", "darwin-arm64", "darwin-x64"]) {
    const installation = await fixture(target);
    try {
      const update = await checkCubeUpdate({ ...installation, fetch: manifestFetch(target) });
      assert.equal(update.currentBuild, currentBuild);
      assert.equal(update.sha256, sha256);
      assert.equal(update.file, `releases/1.0.0/${target === "win32-x64" ? "cube-windows-x64.zip" : `cube-${target}.tar.gz`}`);
      assert.equal(update.installDir, installation.root);
      const same = await checkCubeUpdate({ ...installation, fetch: manifestFetch(target, currentBuild + "0".repeat(48)) });
      assert.equal(same, null);
    } finally { await rm(installation.root, { recursive: true, force: true }); }
  }
});

test("source development skips update requests and invalid publication never becomes an update", async () => {
  assert.equal(await checkCubeUpdate({ execPath: process.execPath, launcher: "", fetch: async () => { throw new Error("must not fetch in development"); } }), null);
  const installation = await fixture();
  try {
    await assert.rejects(checkCubeUpdate({ ...installation, fetch: manifestFetch("win32-x64", sha256, "../unsafe.zip") }), /manifest/i);
    await assert.rejects(checkCubeUpdate({ ...installation, fetch: manifestFetch("win32-x64", sha256, "releases/2.0.0/cube-windows-x64.zip") }), /manifest/i);
    await assert.rejects(checkCubeUpdate({ ...installation, fetch: async () => new Response("offline", { status: 503 }) }), /503/);
  } finally { await rm(installation.root, { recursive: true, force: true }); }
});

test("update preparation verifies the archive before creating a launcher handoff and leaves the current install intact", async () => {
  const installation = await fixture();
  try {
    const update = await checkCubeUpdate({ ...installation, fetch: manifestFetch("win32-x64") });
    assert.ok(update);
    const download = (bytes: Buffer) => (async (url: string | URL | Request) => new Response(String(url).endsWith("install.ps1") ? "# installer" : bytes)) as typeof fetch;
    await assert.rejects(prepareCubeUpdate(update, { fetch: download(payload), signal: AbortSignal.abort() }), { name: "AbortError" });
    await assert.rejects(prepareCubeUpdate(update, { fetch: download(Buffer.from("corrupt")) }), /checksum/i);
    assert.deepEqual((await readdir(installation.root)).sort(), ["bin", "versions"]);
    await prepareCubeUpdate(update, { fetch: download(payload) });
    const pending = path.join(installation.root, ".update");
    assert.equal(await readFile(path.join(pending, "package.zip"), "utf8"), payload.toString());
    const request = JSON.parse(await readFile(path.join(pending, "request.json"), "utf8"));
    assert.equal(request.installDir, installation.root);
    assert.equal(request.launcher, installation.launcher);
    assert.equal(request.sha256, sha256);
    assert.equal(request.cwd, process.cwd());
    assert.deepEqual(request.args, process.argv.slice(2));
    assert.equal(await readFile(installation.execPath, "utf8"), "installed runtime");
    assert.equal(await readFile(installation.launcher, "utf8"), "installed launcher");
    await assert.rejects(prepareCubeUpdate(update, { fetch: download(payload) }), /already pending/i);
  } finally { await rm(installation.root, { recursive: true, force: true }); }
});

test("Windows launcher updates after the old process exits, cleans old versions and restarts or recovers without touching .cube", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "cube update-"));
  const root = path.join(scratch, "installation with spaces");
  const project = path.join(scratch, "project with spaces");
  const home = path.join(scratch, "home", ".cube");
  const stage = path.join(scratch, "package");
  const probe = path.join(scratch, "probe.json");
  const installer = fileURLToPath(new URL("../../../scripts/install.ps1", import.meta.url));
  const run = (command: string, args: string[], options = {}) => {
    const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 90_000,
      env: { ...process.env, PSModulePath: path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "Modules") }, ...options });
    assert.ifError(result.error);
    const diagnostic = result.status === 0 ? "" : JSON.stringify({
      versions: existsSync(path.join(root, "versions")) ? readdirSync(path.join(root, "versions")) : [],
      launcher: existsSync(path.join(root, "bin", "cube.cmd")) ? readFileSync(path.join(root, "bin", "cube.cmd"), "utf8") : null,
      probe: existsSync(probe) ? readFileSync(probe, "utf8") : null,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr + diagnostic);
    return result;
  };
  try {
    await mkdir(path.join(stage, "runtime"), { recursive: true });
    await mkdir(path.join(stage, "app", "dist"), { recursive: true });
    await mkdir(project);
    await mkdir(home, { recursive: true });
    for (const filename of ["config.yaml", "auth.json", "memory.db"]) await writeFile(path.join(home, filename), "untouched user data");
    await cp(process.execPath, path.join(stage, "runtime", "node.exe"));
    await cp(fileURLToPath(new URL("../../../scripts/cube.cmd", import.meta.url)), path.join(stage, "cube.cmd"));
    await writeFile(path.join(stage, "app", "package.json"), '{"type":"module"}');
    await writeFile(path.join(stage, "app", "dist", "main.js"), `
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root = path.dirname(path.dirname(path.dirname(path.dirname(process.execPath))));
if (existsSync(path.join(root, '.update'))) process.exit(75);
writeFileSync(process.env.CUBE_UPDATE_PROBE, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),node:process.execPath,error:process.env.CUBE_UPDATE_ERROR,skip:process.env.CUBE_SKIP_UPDATE}));
`);
    const makeArchive = async (name: string) => {
      const archive = path.join(scratch, name + ".zip");
      run("tar.exe", ["-a", "-c", "-f", archive, "-C", stage, "."]);
      const bytes = await readFile(archive);
      return { archive, bytes, hash: createHash("sha256").update(bytes).digest("hex") };
    };
    const first = await makeArchive("old");
    run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer, "-ArchivePath", first.archive, "-Sha256", first.hash, "-InstallDir", root, "-NoPathUpdate"]);
    const oldNode = path.join(root, "versions", first.hash.slice(0, 16), "runtime", "node.exe");
    const launcher = path.join(root, "bin", "cube.cmd");
    await writeFile(path.join(stage, "build-marker"), "new build");
    const latest = await makeArchive("new");
    const update = await checkCubeUpdate({ execPath: oldNode, launcher, fetch: manifestFetch("win32-x64", latest.hash) });
    assert.ok(update);
    const download = (script: string) => (async (url: string | URL | Request) => new Response(String(url).endsWith("install.ps1") ? script : latest.bytes)) as typeof fetch;
    const actualInstaller = await readFile(installer, "utf8");
    const launch = () => run("cmd.exe", ["/d", "/s", "/c", `""${launcher}" "argument with spaces" "literal;$value""`], {
      cwd: project, windowsVerbatimArguments: true, env: { ...process.env, CUBE_UPDATE_PROBE: probe },
    });
    await prepareCubeUpdate(update, { fetch: download(actualInstaller) });
    const requestPath = path.join(root, ".update", "request.json");
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    await writeFile(requestPath, JSON.stringify({ ...request, cwd: project, args: ["argument with spaces", "literal;$value"] }));
    launch();
    const observed = JSON.parse(await readFile(probe, "utf8"));
    assert.equal(observed.cwd, project);
    assert.deepEqual(observed.args, ["argument with spaces", "literal;$value"]);
    assert.equal(observed.node, path.join(root, "versions", latest.hash.slice(0, 16), "runtime", "node.exe"));
    assert.equal(observed.skip, "1");
    assert.equal(observed.error, undefined);
    assert.deepEqual(await readdir(path.join(root, "versions")), [latest.hash.slice(0, 16)]);
    await assert.rejects(access(path.join(root, ".update")));

    await prepareCubeUpdate(update, { fetch: download("throw 'Installer rejected the update fixture'") });
    const failed = launch();
    const recovered = JSON.parse(await readFile(probe, "utf8"));
    assert.equal(recovered.node, observed.node);
    assert.match(recovered.error, /Installer rejected/);
    assert.doesNotMatch(failed.stdout + failed.stderr, /Installer rejected/);
    assert.deepEqual(await readdir(path.join(root, "versions")), [latest.hash.slice(0, 16)]);
    for (const filename of ["config.yaml", "auth.json", "memory.db"]) assert.equal(await readFile(path.join(home, filename), "utf8"), "untouched user data");
  } finally { await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
