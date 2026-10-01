import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareCubeUpdate } from "../cube-runtime/dist/services/update.service.js";

if (process.platform === "win32") throw new Error("Run the Unix installer smoke on Linux or macOS.");
const archive = path.resolve(process.argv[2]);
const sha256 = (await readFile(`${archive}.sha256`, "utf8")).trim();
const { file } = JSON.parse(await readFile(path.join(path.dirname(archive), "latest.json"), "utf8"));
const installer = fileURLToPath(new URL("./install.sh", import.meta.url));
const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "cube-install-smoke-")));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: scratch, encoding: "utf8", timeout: 120_000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
try {
  const install = path.join(scratch, "installation with spaces");
  const bin = path.join(scratch, "bin with spaces");
  const args = [installer, "--archive", archive, "--sha256", sha256, "--install-dir", install, "--bin-dir", bin];
  run("sh", args);
  const launcher = path.join(bin, "cube");
  const first = await readlink(launcher);
  run("sh", args);
  assert.equal(await readlink(launcher), first, "reinstall should keep the verified version");
  // Exercise the version-named manifest/download path without contacting R2.
  const network = path.join(scratch, "mock-network");
  const manifest = path.join(network, "latest.txt");
  await mkdir(network);
  await writeFile(manifest, `${sha256} ${file}\n`);
  await writeFile(path.join(network, "curl"), `#!/bin/sh
set -eu
url= output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift ;;
    https://*) url=$1 ;;
  esac
  shift
done
case "$url" in
  "https://cube.example.invalid/latest-$CUBE_SMOKE_TARGET.txt") cp "$CUBE_SMOKE_MANIFEST" "$output" ;;
  "https://cube.example.invalid/$CUBE_SMOKE_FILE") cp "$CUBE_SMOKE_ARCHIVE" "$output" ;;
  *) exit 1 ;;
esac
`);
  await chmod(path.join(network, "curl"), 0o755);
  const env = { ...process.env, PATH: `${network}:${process.env.PATH}`,
    CUBE_SMOKE_TARGET: `${process.platform}-${process.arch}`, CUBE_SMOKE_MANIFEST: manifest,
    CUBE_SMOKE_FILE: file, CUBE_SMOKE_ARCHIVE: archive };
  const remoteArgs = [installer, "--base-url", "https://cube.example.invalid", "--install-dir", install, "--bin-dir", bin];
  run("sh", remoteArgs, { env });
  assert.equal(await readlink(launcher), first, "manifest download must retain the checksum-based local version");
  await writeFile(manifest, `${sha256} releases/../cube-${process.platform}-${process.arch}.tar.gz\n`);
  const unsafe = spawnSync("sh", remoteArgs, { cwd: scratch, env, encoding: "utf8", timeout: 30_000 });
  assert.ifError(unsafe.error);
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stderr, /Invalid release version/);
  assert.equal(await readlink(launcher), first, "invalid remote path must not replace the installation");
  const badHash = [...args];
  badHash[4] = "0".repeat(64);
  const rejected = spawnSync("sh", badHash, { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /checksum mismatch/);
  assert.equal(await readlink(launcher), first, "failed upgrade must retain the launcher");
  const destination = path.dirname(first);
  const node = path.join(destination, "runtime/node");
  assert.match(run(node, [path.join(destination, "app/package-smoke.mjs")]), /package-smoke:/);

  // Probe launcher behavior before TUI startup, without touching the real user home.
  const probe = path.join(scratch, "launcher-probe.mjs");
  await writeFile(probe, 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),node:process.execPath}));process.exit(0);\n');
  const cwd = path.join(scratch, "another workspace");
  await mkdir(cwd);
  const output = run(launcher, ["argument with spaces", "literal;$value"], {
    cwd,
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(probe).href}` },
  });
  const observed = JSON.parse(output);
  assert.equal(await realpath(observed.cwd), cwd);
  assert.deepEqual(observed.args, ["argument with spaces", "literal;$value"]);
  assert.equal(await realpath(observed.node), await realpath(node));

  // Exercise the update handoff without a provider call, TUI or a real download.
  const updateProbe = path.join(scratch, "update-probe.mjs");
  await writeFile(updateProbe, `
if (process.argv[1]?.endsWith('/app/dist/main.js')) {
  if (process.env.CUBE_SKIP_UPDATE !== '1') process.exit(75);
  console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),node:process.execPath,error:process.env.CUBE_UPDATE_ERROR}));
  process.exit(0);
}
`);
  const packageBytes = await readFile(archive);
  const installerText = await readFile(installer, "utf8");
  const previousCwd = process.cwd();
  try {
    process.chdir(cwd);
    await prepareCubeUpdate({
      installDir: install, launcher, target: `${process.platform}-${process.arch}`,
      currentBuild: sha256.slice(0, 16), sha256, file,
    }, { fetch: async (url) => new Response(String(url).endsWith("install.sh") ? installerText : packageBytes) });
  } finally { process.chdir(previousCwd); }
  const updated = JSON.parse(run(launcher, ["argument with spaces", "literal;$value"], {
    cwd, env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(updateProbe).href}` },
  }));
  assert.equal(await realpath(updated.cwd), cwd);
  assert.deepEqual(updated.args, ["argument with spaces", "literal;$value"]);
  assert.equal(updated.error, undefined);
  assert.equal(await realpath(updated.node), await realpath(node));
  await assert.rejects(readFile(path.join(install, ".update/run.sh")));

  // An unrelated executable/symlink must never be replaced by the installer.
  await rm(launcher);
  await writeFile(launcher, "unrelated executable");
  assert.notEqual(spawnSync("sh", args).status, 0);
  assert.equal(await readFile(launcher, "utf8"), "unrelated executable");
  await rm(launcher);
  await symlink("/unrelated/cube", launcher);
  assert.notEqual(spawnSync("sh", args).status, 0);
  assert.equal(await readlink(launcher), "/unrelated/cube");
  console.log("install-smoke: install/reinstall, version manifest, checksum rejection, update handoff, bundled launcher, spaces and ownership OK");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
