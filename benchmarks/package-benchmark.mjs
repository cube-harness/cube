import { spawnSync } from "node:child_process";
import { stat, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const zipName = windows ? "cube-windows-x64.zip" : `cube-${process.platform}-${process.arch}.tar.gz`;
const archivePath = path.join(root, "build", windows ? "windows" : `${process.platform}-${process.arch}`, zipName);

async function walk(dir) {
  let files = [];
  let totalBytes = 0;
  let dirCount = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      dirCount += 1;
      const sub = await walk(fullPath);
      files.push(...sub.files);
      totalBytes += sub.totalBytes;
      dirCount += sub.dirCount;
    } else {
      const s = await stat(fullPath);
      files.push({ path: path.relative(dir, fullPath), size: s.size });
      totalBytes += s.size;
    }
  }
  return { files, totalBytes, dirCount };
}

async function runBenchmark() {
  console.log("=== Cube Package Benchmark ===");
  console.log(`Target archive: ${archivePath}`);

  // 1. Archive Stat
  let archiveStat;
  try {
    archiveStat = await stat(archivePath);
  } catch (err) {
    console.error(`Archive not found at ${archivePath}. Run 'pnpm package:app' first.`);
    process.exit(1);
  }

  const archiveMB = (archiveStat.size / (1024 * 1024)).toFixed(2);
  console.log(`Archive size: ${archiveMB} MB (${archiveStat.size.toLocaleString()} bytes)`);

  // 2. Extraction Benchmark
  const tempExtractDir = await mkdtemp(path.join(tmpdir(), "cube-bench-extract-"));
  console.log(`Extracting to temp directory: ${tempExtractDir}`);

  const startExtract = performance.now();
  const tarCmd = windows ? "tar.exe" : "tar";
  const tarArgs = windows ? ["-xf", archivePath, "-C", tempExtractDir] : ["-xzf", archivePath, "-C", tempExtractDir];
  const extractResult = spawnSync(tarCmd, tarArgs, { stdio: "inherit" });
  const extractTimeMs = performance.now() - startExtract;

  if (extractResult.status !== 0) {
    throw new Error(`Extraction failed with exit code ${extractResult.status}`);
  }
  console.log(`Extraction latency: ${(extractTimeMs / 1000).toFixed(3)}s (${extractTimeMs.toFixed(1)}ms)`);

  // 3. Inspect Extracted Files
  const stats = await walk(tempExtractDir);
  const unpackedMB = (stats.totalBytes / (1024 * 1024)).toFixed(2);
  console.log(`Unpacked file count: ${stats.files.length}`);
  console.log(`Unpacked directory count: ${stats.dirCount}`);
  console.log(`Unpacked total size: ${unpackedMB} MB (${stats.totalBytes.toLocaleString()} bytes)`);

  console.log("\nUnpacked files list:");
  for (const f of stats.files) {
    const sizeKB = (f.size / 1024).toFixed(1);
    console.log(`  - ${f.path.padEnd(50)} (${sizeKB.padStart(8)} KB)`);
  }

  // 4. Smoke Test in Extracted Location
  console.log("\nTesting execution in isolated extracted directory...");
  const nodeBinary = path.join(tempExtractDir, "runtime", windows ? "node.exe" : "node");
  const smokeScript = path.join(tempExtractDir, "app", "package-smoke.mjs");

  const startSmoke = performance.now();
  const smokeResult = spawnSync(nodeBinary, [smokeScript], {
    cwd: tempExtractDir,
    stdio: "inherit",
    windowsHide: true,
  });
  const smokeTimeMs = performance.now() - startSmoke;

  if (smokeResult.status !== 0) {
    throw new Error(`Smoke test in isolated extraction failed with code ${smokeResult.status}`);
  }
  console.log(`Smoke test execution time: ${(smokeTimeMs / 1000).toFixed(3)}s (${smokeTimeMs.toFixed(1)}ms)`);

  // Clean up
  await rm(tempExtractDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log("\n=== Benchmark Summary ===");
  console.log(`| Metric                  | Baseline (pnpm deploy) | Single-Bundle (esbuild) | Improvement |`);
  console.log(`| ----------------------- | ---------------------- | ----------------------- | ----------- |`);
  console.log(`| File Count              | ~15,200 files          | ${stats.files.length} files               | -${((1 - stats.files.length / 15200) * 100).toFixed(1)}%     |`);
  console.log(`| Unpacked Disk Footprint | ~360 MB                | ${unpackedMB} MB                | -${((1 - (stats.totalBytes / (1024 * 1024)) / 360) * 100).toFixed(1)}%     |`);
  console.log(`| Archive Size            | ~81 MB                 | ${archiveMB} MB                 | ${(1 - (archiveStat.size / (1024 * 1024)) / 81) >= 0 ? "-" : "+"}${Math.abs((1 - (archiveStat.size / (1024 * 1024)) / 81) * 100).toFixed(1)}%     |`);
  console.log(`| Extraction Latency      | ~25 - 40s (Defender)   | ${(extractTimeMs / 1000).toFixed(2)}s                   | -${((1 - (extractTimeMs / 1000) / 30) * 100).toFixed(1)}%     |`);
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
