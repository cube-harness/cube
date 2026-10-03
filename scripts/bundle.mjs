import * as esbuild from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const NATIVE_LIB_MAP = {
  "win32-x64": "win32-x64-msvc",
  "linux-x64": "linux-x64-gnu",
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
};

/**
 * Bundles the Cube CLI and its smoke tests into the target stage directory.
 * @param {string} stageDir - Path to the stage directory (containing app/, runtime/, etc.)
 * @param {string} target - Target platform string, e.g. win32-x64
 */
export async function bundleApp(stageDir, target = `${process.platform}-${process.arch}`) {
  const appDir = path.join(stageDir, "app");
  const distDir = path.join(appDir, "dist");
  await mkdir(distDir, { recursive: true });

  const commonEsbuildConfig = {
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    banner: {
      js: `import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);`,
    },
    alias: {
      "@cube/runtime": path.join(root, "cube-runtime/src/index.ts"),
      "@cube/workspace": path.join(root, "cube-workspace/src/index.ts"),
      "@cube/agent": path.join(root, "cube-agent/src/index.ts"),
      "@cube/tui": path.join(root, "cube-tui/src/index.ts"),
    },
    nodePaths: [
      path.join(root, "node_modules"),
      path.join(root, "cube-tui/node_modules"),
      path.join(root, "cube-agent/node_modules"),
      path.join(root, "cube-runtime/node_modules"),
      path.join(root, "cube-workspace/node_modules"),
    ],
    external: [],
    logLevel: "warning",
  };

  // 1. Bundle main application into app/dist/main.js
  console.log(`[bundle] Bundling CLI main entry for ${target}...`);
  await esbuild.build({
    ...commonEsbuildConfig,
    entryPoints: [path.join(root, "cube-tui/src/main.ts")],
    outfile: path.join(distDir, "main.js"),
  });

  // 2. Bundle package-smoke.mjs into app/package-smoke.mjs
  console.log(`[bundle] Bundling standalone package-smoke runner...`);
  await esbuild.build({
    ...commonEsbuildConfig,
    entryPoints: [path.join(root, "scripts/package-smoke.mjs")],
    outfile: path.join(appDir, "package-smoke.mjs"),
  });

  // 3. Write package.json for the deployed app
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  await writeFile(
    path.join(appDir, "package.json"),
    JSON.stringify({ name: "@cube/app", version, type: "module" }, null, 2) + "\n"
  );

  // 4. Copy template assets
  console.log(`[bundle] Copying workspace templates...`);
  await cp(
    path.join(root, "cube-workspace/src/template"),
    path.join(distDir, "template"),
    { recursive: true }
  );
  await cp(
    path.join(root, "cube-workspace/src/template"),
    path.join(appDir, "template"),
    { recursive: true }
  );

  // 5. Copy target platform's @libsql native binary into app/node_modules/@libsql/${nativeTarget}
  const nativeTarget = NATIVE_LIB_MAP[target] || target;
  console.log(`[bundle] Resolving native binary for @libsql/${nativeTarget}...`);
  let nativeSrcDir = null;
  try {
    const pkgJsonPath = require.resolve(`@libsql/${nativeTarget}/package.json`);
    nativeSrcDir = path.dirname(pkgJsonPath);
  } catch {
    // Fallback: search in node_modules/.pnpm virtual store
    try {
      const pnpmDir = path.join(root, "node_modules/.pnpm");
      const { readdir } = await import("node:fs/promises");
      const pnpmEntries = await readdir(pnpmDir, { withFileTypes: true });
      const matched = pnpmEntries.find(
        (e) => e.isDirectory() && e.name.startsWith(`@libsql+${nativeTarget}@`)
      );
      if (matched) {
        nativeSrcDir = path.join(pnpmDir, matched.name, "node_modules/@libsql", nativeTarget);
      }
    } catch {}
  }

  if (nativeSrcDir) {
    const nativeDestDir = path.join(appDir, "node_modules/@libsql", nativeTarget);
    await mkdir(nativeDestDir, { recursive: true });
    await cp(nativeSrcDir, nativeDestDir, { recursive: true });
    console.log(`[bundle] Installed native addon: @libsql/${nativeTarget}`);
  } else {
    console.warn(`[bundle] Warning: Could not locate native addon for @libsql/${nativeTarget}.`);
  }
}

// Allow running standalone from CLI for testing
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const testOut = path.join(root, "test-stage");
  await bundleApp(testOut);
  console.log(`[bundle] Standalone test bundle complete at ${testOut}`);
}
