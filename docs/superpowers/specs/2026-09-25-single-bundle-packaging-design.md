# Single-Bundle Packaging & Distribution Optimization Design

**Author**: Antigravity & User  
**Date**: 2026-09-25  
**Branch**: `feature/build-package`  
**Status**: Draft (Approved for Spec Review)  
**Target Platforms**: `win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`

---

## 1. Problem Statement & Motivation

Cube CLI distributes standalone binary archives (`cube-windows-x64.zip`, `cube-darwin-arm64.tar.gz`, etc.) via 1-click shell installer scripts (`install.ps1`, `install.sh`) hosted on Cloudflare R2.

### Symptoms in Production:
1. **Machine Freezing on Install / Extract**: When users download the ~80MB zip package, their system freezes or lags severely during installation.
2. **Exponential Disk Expansion**: The downloaded ~80MB archive unpacks into **~350MB – 400MB** on disk.
3. **I/O & Antivirus Chokepoint**: The build script currently utilizes `pnpm deploy --prod`, copying the entire unbundled production `node_modules` graph. This creates over **15,000 individual files** on the target disk. When `tar.exe` or `Expand-Archive` extracts these files, real-time antivirus engines (e.g. Windows Defender) intercept and scan every single file simultaneously, pinning Disk Usage and CPU at 100%.
4. **Cold Startup Overhead**: On launch, Node.js must traverse and resolve dependencies across thousands of disk entries, resulting in sluggish 800ms–1500ms initial launch latency.

---

## 2. Goals & Non-Goals

### Goals:
- **Zero Disk Freezing**: Eliminate the 15,000-file I/O bottleneck by bundling all application code and pure JS dependencies into a **single, flat JavaScript bundle** (`app/dist/bundle.js`).
- **Dramatic File Count Reduction**: Reduce unpacked file count from **>15,000 files to < 15 files total**.
- **No Size Ballooning**: Ensure unpacked disk footprint remains compact (~80MB – 85MB total, dominated solely by `node.exe` ~70MB and the bundle ~5MB).
- **Sub-Second Extraction**: Extraction time on user machines drops from 20s–45s down to **< 0.5 seconds**.
- **Sub-250ms Cold Startup**: Fast launch without recursive filesystem module resolution.
- **Cross-Platform Parity**: Apply the single-bundle pipeline uniformly across **Windows x64, macOS (ARM64 & x64), and Linux x64**.
- **Zero Breakage Guarantee**: Maintain 100% functional integrity for Mastra agent workflows, LibSQL SQLite embedded persistence, template initialization, prompts, and differential TUI rendering.

### Non-Goals:
- Rewriting core Cube logic or migrating framework off Node.js / Mastra.
- Creating native C/C++ installers (MSI / Inno Setup) at this phase (the shell scripts `install.ps1` and `install.sh` remain the primary distribution vectors).

---

## 3. High-Level Architecture & Transformation

```
[Current Architecture: ~15,000 files]
cube-windows-x64.zip (~80MB)
├── runtime/node.exe (~70MB)
├── cube.cmd
└── app/
    ├── dist/ (tsc output)
    └── node_modules/ (15,000+ files, @mastra, zod, chalk, pi-tui, etc.)
               └── 100% Disk I/O Spike & Defender Freezing

[Target Architecture: < 15 files]
cube-windows-x64.zip (~80MB)
├── runtime/
│   ├── node.exe (~70MB)
│   └── LICENSE
├── cube.cmd / cube (executable launcher)
└── app/
    └── dist/
        ├── bundle.js (Single compiled ESM bundle, ~5MB, includes inlined initialize.prompt.ts)
        └── template/ (Workspace initial configuration templates)
```

---

## 4. Technical Specification

### 4.1. Bundler Architecture (`esbuild`)

We introduce an esbuild packaging step in `scripts/build-binary.mjs` (or via dedicated builder `scripts/bundle.mjs`):

- **Entry Point**: `cube-tui/src/main.ts` (or precompiled `cube-tui/dist/main.js`).
- **Platform**: `node`.
- **Target**: `node22`.
- **Format**: `esm`.
- **Bundle**: `true` (inlines all workspace packages: `@cube/tui`, `@cube/runtime`, `@cube/agent`, `@cube/workspace` and all npm dependencies).
- **Minify**: `false` for debug readability or `true` with `--tree-shaking=true` (reducing bundle size to ~3MB–5MB).
- **External Dependencies**:
  - Node.js built-ins (`node:*`).
  - Native binary addons (`*.node`) such as `@libsql/client` native bindings or SQLite native drivers if used.
- **Banner Injection**:
  ```js
  import { createRequire } from 'node:module';
  const require = createRequire(import.meta.url);
  ```
  *(Ensures compatibility with CJS dependencies bundled into ESM format).*

### 4.2. Handling Static Assets & Inlined Prompts

1. **Prompt Inlining**: `initialize.md` has been converted to `initialize.prompt.ts` (`INITIALIZE_PROMPT` string constant in TypeScript). `esbuild` bundles this prompt directly into `bundle.js`, completely eliminating runtime disk I/O and external file lookup for prompts.
2. **Workspace Templates**: `cube-workspace/src/template` is copied directly to `app/dist/template` so the CLI can bootstrap new workspace configurations.
3. In `bundle.js`, template path resolutions using `import.meta.url` resolve relative to `app/dist/`, preserving exact asset discovery behavior.

### 4.3. Handling Native C++ Addons (`@libsql/client` & SQLite)

- `@mastra/libsql` interacts with `@libsql/client`.
- When `@libsql/client` uses native prebuilt binaries (`@libsql/win32-x64-msvc`, `@libsql/linux-x64-gnu`, `@libsql/darwin-arm64`), these `.node` files cannot be serialized into JavaScript code.
- **Solution**:
  - In esbuild, mark native `.node` modules or `@libsql/client` native bindings as external or use an esbuild native node plugin that places the `.node` binary in `app/dist/` and loads it via `process.dlopen`.
  - If `@libsql/client` is in pure WASM/HTTP mode or embedded native, test and ensure the native binary is co-located in `app/dist/native/`.

### 4.4. Launcher Scripts Update

#### Windows (`scripts/cube.cmd`):
```cmd
@echo off
setlocal
set "PATH=%~dp0runtime;%PATH%"
"%~dp0runtime\node.exe" "%~dp0app\dist\bundle.js" %*
exit /b %errorlevel%
```

#### Unix / macOS / Linux (`scripts/cube`):
```bash
#!/bin/sh
BASE="$(cd "$(dirname "$0")" && pwd)"
export PATH="$BASE/runtime:$PATH"
exec "$BASE/runtime/node" "$BASE/app/dist/bundle.js" "$@"
```

### 4.5. Multi-Platform Support Matrix

The build script `scripts/build-binary.mjs` will build natively on whichever platform it runs, or package cross-platform tarballs where Node runtime binaries are downloaded/provided:
- **Windows x64**: `cube-windows-x64.zip` (bundled with `node.exe`)
- **macOS Apple Silicon**: `cube-darwin-arm64.tar.gz` (bundled with `node`)
- **macOS Intel**: `cube-darwin-x64.tar.gz` (bundled with `node`)
- **Linux x64**: `cube-linux-x64.tar.gz` (bundled with `node`)

---

## 5. Verification & Measurable Benchmark Plan

To ensure all claims are empirically validated on disk, we will execute an automated benchmark comparing the baseline build vs the optimized single-bundle build:

### Test 1: File Count Audit
- **Measurement**: `(Get-ChildItem -Path $Expanded -Recurse -File).Count`
- **Baseline**: ~15,200 files
- **Acceptance Target**: **< 15 files** (reduction of > 99.9%)

### Test 2: Unpacked Disk Footprint
- **Measurement**: Total size of extracted directory in MB
- **Baseline**: ~360MB
- **Acceptance Target**: **< 90MB** (reduction of ~75%, zero inflation from download size)

### Test 3: Unpack & Extraction Latency
- **Measurement**: Wall-clock execution time of archive decompression
- **Baseline**: 25s – 40s (Disk saturated at 100%)
- **Acceptance Target**: **< 0.5s** (instantaneous decompression)

### Test 4: CLI Cold Startup Latency
- **Measurement**: Time to execute `cube --version` or help output
- **Baseline**: 850ms – 1200ms
- **Acceptance Target**: **< 250ms**

### Test 5: Smoke Test Integrity
- Execute `scripts/package-smoke.mjs` on the newly packaged stage:
  - SQLite database creation and schema migration.
  - Template copying and AGENTS.md rule discovery.
  - TUI screen initialization and teardown without runtime exceptions.
  - **Acceptance Target**: 100% Pass (0 errors).

---

## 6. Implementation Stages (Next Steps)

1. **Phase 1**: Add `esbuild` dependency to root workspace and create `scripts/bundle.mjs`.
2. **Phase 2**: Configure esbuild build pipeline for all monorepo packages into `app/dist/bundle.js` with native addon and asset handling.
3. **Phase 3**: Update `scripts/build-binary.mjs` to replace `pnpm deploy` with the single-bundle pipeline.
4. **Phase 4**: Update `cube.cmd` and `cube` launchers to invoke `bundle.js`.
5. **Phase 5**: Run automated benchmarks and functional smoke test to produce real empirical numbers.
6. **Phase 6**: Package final archives for Windows, macOS, and Linux and update R2 release manifests.
