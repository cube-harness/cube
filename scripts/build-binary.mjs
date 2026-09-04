#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const releaseDir = path.join(rootDir, "release");

console.log("🚀 Starting Cube Release Build...");

// 1. Clean & create release directory
if (fs.existsSync(releaseDir)) {
  fs.rmSync(releaseDir, { recursive: true, force: true });
}
fs.mkdirSync(releaseDir, { recursive: true });

// 2. Build monorepo packages first
console.log("📦 Building monorepo packages...");
execSync("pnpm run build", { cwd: rootDir, stdio: "inherit" });

// 3. Read package version
const pkgPath = path.join(rootDir, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
const version = pkg.version || "1.0.0";
console.log(`🔖 Packaging version v${version}...`);

// 4. Bundle into a standalone bundle using esbuild (ESM)
const bundlePath = path.join(releaseDir, "cube.mjs");
console.log("⚡ Bundling with esbuild into single standalone file (ESM)...");

const entryPoint = path.join(rootDir, "cube-tui", "src", "main.ts");
const esbuildCmd = [
  "npx esbuild",
  `"${entryPoint}"`,
  `--outfile="${bundlePath}"`,
  "--bundle",
  "--platform=node",
  "--target=node22",
  "--format=esm",
  "--sourcemap=inline",
  "--external:*.node",
  `--banner:js="import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"`,
].join(" ");

execSync(esbuildCmd, { cwd: rootDir, stdio: "inherit" });

// 5. Copy required native modules into release/node_modules
console.log("📦 Copying native binary dependencies...");
const releaseNodeModules = path.join(releaseDir, "node_modules");
fs.mkdirSync(releaseNodeModules, { recursive: true });

function copyFromPnpm(pkgPattern, targetSubdir) {
  const pnpmDir = path.join(rootDir, "node_modules", ".pnpm");
  if (!fs.existsSync(pnpmDir)) return;
  try {
    const entries = fs.readdirSync(pnpmDir);
    for (const entry of entries) {
      if (entry.includes(pkgPattern)) {
        const candidateDir = path.join(pnpmDir, entry, "node_modules", targetSubdir);
        if (fs.existsSync(candidateDir)) {
          const dest = path.join(releaseNodeModules, targetSubdir);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.cpSync(candidateDir, dest, { recursive: true });
        }
      }
    }
  } catch (err) {
    console.warn(`Could not copy ${targetSubdir}:`, err.message);
  }
}

copyFromPnpm("@libsql+win32-x64-msvc", "@libsql/win32-x64-msvc");
copyFromPnpm("@libsql+darwin-arm64", "@libsql/darwin-arm64");
copyFromPnpm("@libsql+darwin-x64", "@libsql/darwin-x64");
copyFromPnpm("@libsql+linux-x64-gnu", "@libsql/linux-x64-gnu");
copyFromPnpm("libsql@", "libsql");
copyFromPnpm("bufferutil@", "bufferutil");

// 6. Create platform-specific launchers
console.log("🛠️ Creating platform launchers...");

// Windows CMD launcher
const winCmdLauncher = `@echo off\r\nnode "%~dp0cube.mjs" %*\r\n`;
fs.writeFileSync(path.join(releaseDir, "cube.cmd"), winCmdLauncher);

// Windows PS1 launcher
const winPs1Launcher = `& node "$PSScriptRoot/cube.mjs" @args\r\n`;
fs.writeFileSync(path.join(releaseDir, "cube.ps1"), winPs1Launcher);

// Unix executable launcher
const unixLauncher = `#!/usr/bin/env sh\nDIR="$(cd "$(dirname "$0")" && pwd)"\nexec node "$DIR/cube.mjs" "$@"\n`;
const unixLauncherPath = path.join(releaseDir, "cube");
fs.writeFileSync(unixLauncherPath, unixLauncher, { mode: 0o755 });

// 7. Create archive packages for distribution
console.log("📦 Packaging archives for Windows, macOS, and Linux...");

// Helper for SHA256
function computeSha256(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(fileBuffer).digest("hex");
}

const checksums = {};

// Windows Package (cube-windows-x64.zip)
const winZipPath = path.join(releaseDir, `cube-windows-x64.zip`);
const winFiles = ["cube.mjs", "cube.cmd", "cube.ps1", "node_modules"];

try {
  const winFilesList = winFiles.map((f) => `"${path.join(releaseDir, f)}"`).join(",");
  if (process.platform === "win32") {
    execSync(`powershell -Command "Compress-Archive -Path ${winFilesList} -DestinationPath '${winZipPath}' -Force"`, {
      stdio: "inherit",
    });
  } else {
    execSync(`cd "${releaseDir}" && zip -r "cube-windows-x64.zip" ${winFiles.join(" ")}`, {
      stdio: "inherit",
    });
  }
  checksums["cube-windows-x64.zip"] = computeSha256(winZipPath);
} catch (e) {
  console.warn("⚠️ Could not create Windows zip package:", e.message);
}

// Unix Packages (Darwin arm64, Darwin x64, Linux x64)
const unixTargets = [
  { name: "cube-darwin-arm64.tar.gz" },
  { name: "cube-darwin-x64.tar.gz" },
  { name: "cube-linux-x64.tar.gz" },
];

for (const target of unixTargets) {
  const tarPath = path.join(releaseDir, target.name);
  try {
    execSync(`tar -czf "${tarPath}" -C "${releaseDir}" cube cube.mjs node_modules`, { stdio: "inherit" });
    checksums[target.name] = computeSha256(tarPath);
  } catch (e) {
    console.warn(`⚠️ Could not create ${target.name}:`, e.message);
  }
}

// 7. Write manifest & checksums
const manifest = {
  name: "cube",
  version,
  buildTime: new Date().toISOString(),
  checksums,
};

fs.writeFileSync(path.join(releaseDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("✅ Build complete! Release artifacts in /release directory:");
for (const [file, hash] of Object.entries(checksums)) {
  console.log(`  - ${file} (SHA256: ${hash.slice(0, 12)}...)`);
}
