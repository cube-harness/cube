import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(new URL("../cube-workspace/package.json", import.meta.url));
const workflow = require("yaml").parse(await readFile(new URL("../.github/workflows/package.yml", import.meta.url), "utf8"));
const publish = workflow.jobs.publish.steps.find((step) => step.name?.startsWith("Publish to R2"));
const archives = ["cube-windows-x64.zip", "cube-linux-x64.tar.gz", "cube-darwin-arm64.tar.gz", "cube-darwin-x64.tar.gz"];
const version = "1.2.0";
const key = (version, archive) => `releases/${version}/${archive}`;
const objects = archives.flatMap((archive) => [
  { Key: key(version, archive), LastModified: "2026-09-01T00:00:00Z" },
  { Key: key("1.1.0", archive), LastModified: "2026-09-30T00:00:00Z" },
  { Key: key("1.0.0", archive), LastModified: "2026-09-20T00:00:00Z" },
]);
objects.push({ Key: "releases/1.0.0/notes.txt", LastModified: "2026-01-01T00:00:00Z" });

// Run the actual workflow script; replace only the external R2 boundary.
const harness = `
$script:events = [Collections.Generic.List[object]]::new()
function aws {
  $arguments = @($args)
  $script:events.Add($arguments)
  $global:LASTEXITCODE = 0
  if ($arguments[0] -eq 's3' -and $arguments[1] -eq 'cp') {
    if ($arguments[3] -eq "s3://test-bucket/$env:CUBE_TEST_FAIL_KEY") { $global:LASTEXITCODE = 1 }
  } elseif ($arguments[0] -eq 's3api' -and $arguments[1] -eq 'list-objects-v2') {
    $prefix = $arguments[$arguments.IndexOf('--prefix') + 1]
    if ($prefix -eq 'releases/') { Get-Content -LiteralPath 'objects.json' -Raw }
    elseif ($prefix -eq 'releases/1.2.0/') {
      if ($env:CUBE_TEST_FAIL_VERSION_CHECK -eq 'true') { $global:LASTEXITCODE = 1; return }
      Get-Content -LiteralPath 'existing.json' -Raw
    }
    else { throw "Unexpected release prefix: $prefix" }
  } elseif ($arguments[0] -eq 's3api' -and $arguments[1] -eq 'delete-object') {
    if ($env:CUBE_TEST_FAIL_DELETE -eq 'true') { $global:LASTEXITCODE = 1 }
  } else { throw "Unexpected AWS command: $arguments" }
}
try { & ([scriptblock]::Create($env:CUBE_TEST_PUBLISH)); $result = 0 }
catch { Write-Host $_; $result = 1 }
ConvertTo-Json -InputObject @($script:events.ToArray()) -Depth 5 -Compress | Set-Content -LiteralPath 'events.json'
exit $result
`;

async function run({ failKey = "", listed = objects, existing = [], unixVersion = version, failDelete = false, failVersionCheck = false } = {}) {
  const scratch = await mkdtemp(path.join(tmpdir(), "cube-r2-publish-test-"));
  try {
    for (const archive of archives) {
      const target = archive.replace(/^cube-/, "").replace(/\.(zip|tar\.gz)$/, "");
      const directory = path.join(scratch, "packages", `cube-${target}`);
      await mkdir(directory, { recursive: true });
      const releaseVersion = target === "windows-x64" ? version : unixVersion;
      await writeFile(path.join(directory, "latest.json"), JSON.stringify({ version: releaseVersion, sha256: "a".repeat(64), file: key(releaseVersion, archive) }));
      if (target !== "windows-x64") {
        await writeFile(path.join(directory, `latest-${target}.txt`), `${"a".repeat(64)} ${key(releaseVersion, archive)}\n`);
      }
    }
    await writeFile(path.join(scratch, "objects.json"), JSON.stringify({ Contents: listed }));
    await writeFile(path.join(scratch, "existing.json"), JSON.stringify({ KeyCount: existing.length, Contents: existing }));
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", harness], {
      cwd: scratch,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test",
        R2_BUCKET: "test-bucket", R2_ENDPOINT: "https://example.invalid",
        CUBE_TEST_PUBLISH: publish.run, CUBE_TEST_FAIL_KEY: failKey,
        CUBE_TEST_FAIL_DELETE: String(failDelete),
        CUBE_TEST_FAIL_VERSION_CHECK: String(failVersionCheck),
      },
    });
    if (result.error) throw result.error;
    const events = JSON.parse(await readFile(path.join(scratch, "events.json"), "utf8"));
    return { ...result, events, deleted: events.filter((args) => args[1] === "delete-object").map((args) => args[args.indexOf("--key") + 1]) };
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("successful publish keeps the active archive plus newest previous archive per OS", async () => {
  const result = await run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.deleted.sort(), archives.map((archive) => key("1.0.0", archive)).sort());
  assert.deepEqual(result.events.filter((args) => args[0] === "s3").slice(0, 4).map((args) => args[3]), archives.map((archive) => `s3://test-bucket/${key(version, archive)}`));
  const listAt = result.events.findLastIndex((args) => args[1] === "list-objects-v2");
  const lastUpload = result.events.findLastIndex((args) => args[0] === "s3");
  assert.ok(listAt > lastUpload, "cleanup must follow all uploads and manifests");
});

test("an archive, installer or manifest upload failure never reaches cleanup", async () => {
  for (const failKey of [...archives.map((archive) => key(version, archive)), "install.ps1", "install.sh", "latest.json", "latest-linux-x64.txt", "latest-darwin-arm64.txt", "latest-darwin-x64.txt"]) {
    const result = await run({ failKey });
    assert.equal(result.status, 1, failKey);
    assert.deepEqual(result.deleted, [], failKey);
    assert.ok(!result.events.some((args) => args[1] === "list-objects-v2" && args[args.indexOf("--prefix") + 1] === "releases/"), failKey);
  }
});

test("missing active archive aborts before deleting any old version", async () => {
  const result = await run({ listed: objects.filter((object) => object.Key !== key(version, archives[3])) });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(result.deleted, []);
});

test("cleanup stops and reports a failed delete", async () => {
  const result = await run({ failDelete: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.deleted.length, 1);
});

test("existing version, including a partial publish, fails before any upload or delete", async () => {
  for (const existing of [[objects[0]], archives.map((archive) => ({ Key: key(version, archive) }))]) {
    const result = await run({ existing });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /already exists/i);
    assert.ok(!result.events.some((args) => args[0] === "s3"));
    assert.deepEqual(result.deleted, []);
  }
});

test("mixed platform versions fail before any upload or delete", async () => {
  const result = await run({ unixVersion: "1.2.1" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(!result.events.some((args) => args[0] === "s3"));
  assert.deepEqual(result.deleted, []);
});

test("failed version existence check fails closed without uploading or deleting", async () => {
  const result = await run({ failVersionCheck: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Cannot check existing R2 version/);
  assert.ok(!result.events.some((args) => args[0] === "s3"));
  assert.deepEqual(result.deleted, []);
});
