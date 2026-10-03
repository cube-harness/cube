import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const baseUrl = "https://pub-3313f2900e0948b5849dc47c989406ab.r2.dev";
const targets = ["win32-x64", "linux-x64", "darwin-arm64", "darwin-x64"];
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type CubeUpdate = {
  installDir: string;
  launcher: string;
  target: string;
  currentVersion: string;
  version: string;
  sha256: string;
  file: string;
};

export async function checkCubeUpdate(options: {
  execPath?: string;
  launcher?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: typeof fetch;
} = {}): Promise<CubeUpdate | null> {
  const launcher = options.launcher ?? process.env.CUBE_LAUNCHER;
  const target = `${options.platform ?? process.platform}-${options.arch ?? process.arch}`;
  if (!launcher || !targets.includes(target)) return null;
  const executable = await realpath(options.execPath ?? process.execPath);
  const versionDir = path.dirname(path.dirname(executable));
  const currentBuild = path.basename(versionDir);
  if (path.basename(path.dirname(executable)) !== "runtime" ||
      path.basename(path.dirname(versionDir)) !== "versions" ||
      !/^[a-f0-9]{16}$/.test(currentBuild)) return null;
  const installDir = path.dirname(path.dirname(versionDir));
  const launcherPath = path.resolve(launcher);
  if (target === "win32-x64" && launcherPath.toLowerCase() !== path.join(installDir, "bin", "cube.cmd").toLowerCase()) return null;
  if (target !== "win32-x64" && (path.basename(launcherPath) !== "cube" || launcherPath.startsWith(versionDir + path.sep))) return null;
  await access(launcherPath);

  const windows = target === "win32-x64";
  const response = await (options.fetch ?? fetch)(`${baseUrl}/${windows ? "latest.json" : `latest-${target}.txt`}`, {
    cache: "no-store", signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`Update check failed: HTTP ${response.status}.`);
  const text = (await response.text()).replace(/^\uFEFF/, "").trim();
  let manifest: { version?: string; platform: string; sha256: string; file: string };
  try {
    const [sha256, file, extra] = text.split(/\s+/);
    if (!windows && extra) throw new Error("Extra manifest fields");
    manifest = windows ? JSON.parse(text) : { platform: target, sha256, file };
    if (!manifest || typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256) || typeof manifest.file !== "string")
      throw new Error("Invalid checksum");
  } catch { throw new Error("Invalid Cube update manifest."); }
  const filename = windows ? "cube-windows-x64.zip" : `cube-${target}.tar.gz`;
  const version = windows ? manifest.version : manifest.file.split("/")[1];
  if (typeof version !== "string" || !versionPattern.test(version) ||
      manifest.platform !== target || manifest.file !== `releases/${version}/${filename}`)
    throw new Error("Invalid Cube update manifest.");
  if (manifest.sha256.slice(0, 16) === currentBuild) return null;
  const installedVersion = await readFile(path.join(versionDir, "app", "package.json"), "utf8")
    .then((text) => JSON.parse(text).version).catch(() => undefined);
  const currentVersion = typeof installedVersion === "string" && versionPattern.test(installedVersion)
    ? installedVersion : "Unknown";
  return { installDir, launcher: launcherPath, target, currentVersion, version, sha256: manifest.sha256, file: manifest.file };
}

// The launcher runs this only after the old Node process exits (code 75).
// Native installers remain responsible for extraction, launcher replacement and cleanup.
const windowsHandoff = String.raw`$ErrorActionPreference = 'Stop'
$request = Get-Content (Join-Path $PSScriptRoot 'request.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$pending = [IO.Path]::GetFullPath($PSScriptRoot)
if ($pending -ne [IO.Path]::GetFullPath((Join-Path $request.installDir '.update'))) { throw 'Invalid update directory.' }
try {
  & (Join-Path $pending 'install.ps1') -ArchivePath (Join-Path $pending 'package.zip') -Sha256 $request.sha256 -InstallDir $request.installDir -NoPathUpdate *> (Join-Path $pending 'install.log')
} catch {
  $env:CUBE_UPDATE_ERROR = 'Update failed. Using the previous build. ' + $_.Exception.Message
}
$env:CUBE_SKIP_UPDATE = '1'
Set-Location -LiteralPath $request.cwd
$launcher = $request.launcher
$arguments = @($request.args)
Remove-Item -LiteralPath $pending -Recurse -Force -ErrorAction SilentlyContinue
& $launcher @arguments
exit $LASTEXITCODE
`;

const unixHandoff = String.raw`#!/bin/sh
set -eu
pending=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
. "$pending/request.sh"
[ "$pending" = "$cube_install/.update" ] || exit 1
if ! sh "$pending/install.sh" --archive "$pending/package.tar.gz" --sha256 "$cube_sha" --install-dir "$cube_install" --bin-dir "$(dirname -- "$cube_launcher")" >"$pending/install.log" 2>&1; then
  CUBE_UPDATE_ERROR="Update failed. Using the previous build. $(tail -c 2000 "$pending/install.log")"
  export CUBE_UPDATE_ERROR
fi
CUBE_SKIP_UPDATE=1
export CUBE_SKIP_UPDATE
cd "$cube_cwd"
rm -rf -- "$pending"
exec "$cube_launcher" "$@"
`;

export async function prepareCubeUpdate(update: CubeUpdate, options: {
  fetch?: typeof fetch;
  signal?: AbortSignal;
} = {}): Promise<void> {
  const pending = path.join(update.installDir, ".update");
  if (await access(pending).then(() => true, () => false))
    throw new Error(`A Cube update is already pending at ${pending}. Close other Cube instances and remove that staging directory before retrying.`);
  const stage = await mkdtemp(path.join(update.installDir, ".update-"));
  const windows = update.target === "win32-x64";
  const installer = windows ? "install.ps1" : "install.sh";
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(1_800_000)])
    : AbortSignal.timeout(1_800_000);
  try {
    const request = options.fetch ?? fetch;
    const script = await request(`${baseUrl}/${installer}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), cache: "no-store" });
    if (!script.ok) throw new Error(`Cannot download Cube installer: HTTP ${script.status}.`);
    await writeFile(path.join(stage, installer), await script.text());
    const archive = await request(`${baseUrl}/${update.file}`, { signal });
    if (!archive.ok || !archive.body) throw new Error(`Cannot download Cube package: HTTP ${archive.status}.`);
    const hash = createHash("sha256");
    await pipeline(Readable.fromWeb(archive.body as import("node:stream/web").ReadableStream), async function* (source) {
      for await (const chunk of source) { hash.update(chunk); yield chunk; }
    }, createWriteStream(path.join(stage, windows ? "package.zip" : "package.tar.gz")), { signal });
    if (hash.digest("hex") !== update.sha256) throw new Error("Cube package checksum mismatch. The current installation is unchanged.");
    if (windows) {
      await writeFile(path.join(stage, "request.json"), JSON.stringify({ ...update, cwd: process.cwd(), args: process.argv.slice(2) }));
      await writeFile(path.join(stage, "run.ps1"), windowsHandoff);
      await writeFile(path.join(stage, "run.cmd"), '@echo off\r\nsetlocal\r\nset "PSModulePath=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\Modules"\r\n(\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1"\r\nexit /b\r\n)\r\n');
    } else {
      const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
      await writeFile(path.join(stage, "request.sh"), [
        `cube_install=${quote(update.installDir)}`, `cube_launcher=${quote(update.launcher)}`,
        `cube_sha=${quote(update.sha256)}`, `cube_cwd=${quote(process.cwd())}`,
      ].join("\n") + "\n");
      await writeFile(path.join(stage, "run.sh"), unixHandoff);
    }
    signal.throwIfAborted();
    await rename(stage, pending);
  } finally { await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
