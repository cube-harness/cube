#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const platform = process.platform;
const arch = process.arch;

let target = null;
if (platform === "win32" && arch === "x64") target = "win32-x64";
else if (platform === "linux" && arch === "x64") target = "linux-x64";
else if (platform === "darwin" && arch === "arm64") target = "darwin-arm64";
else if (platform === "darwin" && arch === "x64") target = "darwin-x64";
else {
  console.error(`Unsupported platform/architecture: ${platform}-${arch}. Cube supports Windows x64, Linux x64, and macOS.`);
  process.exit(1);
}

const baseUrl = (process.env.CUBE_BASE_URL || "https://pub-3313f2900e0948b5849dc47c989406ab.r2.dev").replace(/\/+$/, "");

async function getMetadata() {
  if (target === "win32-x64") {
    const res = await fetch(`${baseUrl}/latest.json`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return { sha256: data.sha256, remoteFile: data.file };
  } else {
    const res = await fetch(`${baseUrl}/latest-${target}.txt`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status} ${res.statusText}`);
    const text = (await res.text()).trim();
    const parts = text.split(/\s+/);
    return { sha256: parts[0], remoteFile: parts[1] };
  }
}

async function main() {
  const isInstallOnly = process.argv.includes("--install-only");
  const homeDir = os.homedir();
  const installRoot =
    platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "cube")
      : path.join(homeDir, ".local", "share", "cube");

  let metadata;
  try {
    metadata = await getMetadata();
  } catch (err) {
    if (isInstallOnly) {
      console.warn(`Warning: Could not check for updates from R2: ${err.message}`);
      process.exit(0);
    }
    throw err;
  }

  const { sha256, remoteFile } = metadata;
  const versionKey = sha256.slice(0, 16);
  const versionDir = path.join(installRoot, "versions", versionKey);
  const binDir =
    platform === "win32" ? path.join(installRoot, "bin") : path.join(homeDir, ".local", "bin");

  const nodeBinary = path.join(versionDir, "runtime", platform === "win32" ? "node.exe" : "node");
  const mainScript = path.join(versionDir, "app", "dist", "main.js");

  let isInstalled = false;
  try {
    await fs.access(nodeBinary);
    await fs.access(mainScript);
    isInstalled = true;
  } catch {
    isInstalled = false;
  }

  if (!isInstalled) {
    await fs.mkdir(installRoot, { recursive: true });
    const stagingDir = await fs.mkdtemp(path.join(installRoot, ".install-"));
    try {
      const archiveUrl = `${baseUrl}/${remoteFile}`;
      const archivePath = path.join(stagingDir, platform === "win32" ? "cube.zip" : "cube.tar.gz");
      console.log(`[cube] Downloading Cube for ${target} (${versionKey})...`);

      const response = await fetch(archiveUrl);
      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);

      const hasher = crypto.createHash("sha256");
      const fileStream = createWriteStream(archivePath);

      for await (const chunk of response.body) {
        hasher.update(chunk);
        fileStream.write(chunk);
      }

      await new Promise((resolve, reject) => {
        fileStream.end((err) => (err ? reject(err) : resolve()));
      });

      const downloadedHash = hasher.digest("hex");
      if (downloadedHash.toLowerCase() !== sha256.toLowerCase()) {
        throw new Error(`Checksum mismatch: expected ${sha256}, got ${downloadedHash}`);
      }

      console.log("[cube] Extracting package...");
      const expandedDir = path.join(stagingDir, "package");
      await fs.mkdir(expandedDir, { recursive: true });

      if (platform === "win32") {
        const tarResult = spawnSync("tar.exe", ["-xf", archivePath, "-C", expandedDir], {
          windowsHide: true,
        });
        if (tarResult.status !== 0) {
          spawnSync("powershell", [
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${expandedDir}' -Force`,
          ]);
        }
      } else {
        const tarResult = spawnSync("tar", ["-xzf", archivePath, "-C", expandedDir]);
        if (tarResult.status !== 0) throw new Error("Failed to extract package archive using tar.");
      }

      await fs.mkdir(path.join(installRoot, "versions"), { recursive: true });
      await fs.rename(expandedDir, versionDir);

      if (platform !== "win32") {
        await fs.chmod(path.join(versionDir, "runtime", "node"), 0o755);
        try {
          await fs.chmod(path.join(versionDir, "cube"), 0o755);
        } catch {}
      }

      // Maintain bin launcher
      await fs.mkdir(binDir, { recursive: true });
      if (platform === "win32") {
        const launcher = `@echo off\r\nsetlocal\r\nset "PATH=%~dp0..\\versions\\${versionKey}\\runtime;%PATH%"\r\n"%~dp0..\\versions\\${versionKey}\\runtime\\node.exe" "%~dp0..\\versions\\${versionKey}\\app\\dist\\main.js" %*\r\nexit /b %errorlevel%\r\n`;
        await fs.writeFile(path.join(binDir, "cube.cmd"), launcher, "ascii");
      } else {
        const launcherSymlink = path.join(binDir, "cube");
        try {
          await fs.unlink(launcherSymlink);
        } catch {}
        try {
          await fs.symlink(path.join(versionDir, "cube"), launcherSymlink);
        } catch {}
      }

      console.log("[cube] Setup complete!");
    } finally {
      try {
        await fs.rm(stagingDir, { recursive: true, force: true });
      } catch {}
    }
  }

  if (isInstallOnly) {
    process.exit(0);
  }

  // Execute the bundled binary
  const env = { ...process.env };
  const runtimeDir = path.join(versionDir, "runtime");
  env.PATH = `${runtimeDir}${path.delimiter}${env.PATH || ""}`;

  const forwardArgs = process.argv.slice(2).filter((arg) => arg !== "--install-only");
  const child = spawn(
    path.join(versionDir, "runtime", platform === "win32" ? "node.exe" : "node"),
    [path.join(versionDir, "app", "dist", "main.js"), ...forwardArgs],
    {
      stdio: "inherit",
      env,
    }
  );

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(`[cube] Error: ${err.message}`);
  process.exit(1);
});
