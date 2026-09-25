import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform === "win32") throw new Error("Run the Unix installer smoke on Linux or macOS.");
const archive = path.resolve(process.argv[2]);
const sha256 = (await readFile(`${archive}.sha256`, "utf8")).trim();
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

  // An unrelated executable/symlink must never be replaced by the installer.
  await rm(launcher);
  await writeFile(launcher, "unrelated executable");
  assert.notEqual(spawnSync("sh", args).status, 0);
  assert.equal(await readFile(launcher, "utf8"), "unrelated executable");
  await rm(launcher);
  await symlink("/unrelated/cube", launcher);
  assert.notEqual(spawnSync("sh", args).status, 0);
  assert.equal(await readlink(launcher), "/unrelated/cube");
  console.log("install-smoke: install/reinstall, checksum rejection, bundled launcher, spaces and ownership OK");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
