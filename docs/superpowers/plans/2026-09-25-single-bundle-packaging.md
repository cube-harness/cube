# Single-Bundle Packaging & Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate machine freezing and exponential disk inflation during Cube CLI installation by bundling application code into a single, high-performance ESM bundle (`bundle.js`), reducing unpacked file count from >15,000 files to <15 files.

**Architecture:** Replace the unbundled `pnpm deploy` copy of `node_modules` with an `esbuild` bundler pipeline in `scripts/bundle.mjs`. The pipeline inlines all monorepo packages and JavaScript dependencies into `app/dist/bundle.js`, copies workspace templates, and invokes the single bundle from `cube.cmd` and `cube` launchers with bundled Node.js runtime.

**Tech Stack:** Node.js 22, esbuild, TypeScript 5.7, pnpm monorepo (Turborepo), LibSQL, Mastra Agent Framework, PowerShell / Bash.

---

## Global Constraints

- **Branch**: All work must be committed to branch `feature/build-package`.
- **Zero Breakage**: SQLite persistence (LibSQL), AGENTS.md rule discovery, templates, OAuth gateways, and pi-tui terminal differential rendering must remain 100% functional.
- **Empirical Numbers Required**: Measure file count, unpacked folder size, extraction latency, and startup latency before and after.

---

### Task 1: Complete Inlined Initialize Prompt Migration in `cube-agent`

**Files:**
- Modify: `cube-agent/src/processors/initialize.processor.ts:1-35`
- Test: `pnpm --filter @cube/agent test`

- [ ] **Step 1: Update `initialize.processor.ts` to import `INITIALIZE_PROMPT`**

Modify `cube-agent/src/processors/initialize.processor.ts` to import `INITIALIZE_PROMPT` directly from `../prompts/initialize.prompt.js`, replacing `existsSync` and `readFileSync` with the in-memory string constant.

- [ ] **Step 2: Verify `cube-agent` typecheck and tests**

Run:
```powershell
pnpm --filter @cube/agent typecheck
pnpm --filter @cube/agent test
```
Expected: PASS with 0 errors.

---

### Task 2: Install `esbuild` and Author `scripts/bundle.mjs`

**Files:**
- Modify: `package.json` (add `esbuild` to root devDependencies)
- Create: `scripts/bundle.mjs`

- [ ] **Step 1: Add `esbuild` to root workspace**

Run:
```powershell
pnpm add -D -w esbuild
```

- [ ] **Step 2: Create `scripts/bundle.mjs`**

Create `scripts/bundle.mjs` to bundle `cube-tui/src/main.ts` into target staging directory:
- Entry point: `cube-tui/src/main.ts`
- Format: `esm`
- Platform: `node`
- Target: `node22`
- Banner: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`
- Inlines all workspace packages (`@cube/tui`, `@cube/runtime`, `@cube/agent`, `@cube/workspace`) and third-party pure JS modules.
- Copies `cube-workspace/src/template` to `app/dist/template`.
- Copies any native `.node` binary bindings if required.

- [ ] **Step 3: Test bundle generation locally**

Run:
```powershell
node scripts/bundle.mjs
```
Verify `app/dist/bundle.js` is created and is a valid self-contained ESM bundle.

---

### Task 3: Update `scripts/build-binary.mjs` and Launchers

**Files:**
- Modify: `scripts/build-binary.mjs`
- Modify: `scripts/cube.cmd`
- Modify: `scripts/cube`
- Modify: `scripts/package-smoke.mjs`

- [ ] **Step 1: Update `scripts/build-binary.mjs`**

Replace lines 32–48 (`pnpm deploy` and `checkLinks`) with the `bundle.mjs` pipeline.
Ensure stage directory contains only:
- `runtime/node.exe` (or `node`) + `runtime/LICENSE`
- `cube.cmd` (Windows) / `cube` (Unix)
- `app/dist/bundle.js`
- `app/dist/template/`

- [ ] **Step 2: Update `scripts/cube.cmd`**

Update command to invoke `bundle.js`:
```cmd
@echo off
setlocal
set "PATH=%~dp0runtime;%PATH%"
"%~dp0runtime\node.exe" "%~dp0app\dist\bundle.js" %*
exit /b %errorlevel%
```

- [ ] **Step 3: Update `scripts/cube` for macOS and Linux**

```bash
#!/bin/sh
BASE="$(cd "$(dirname "$0")" && pwd)"
export PATH="$BASE/runtime:$PATH"
exec "$BASE/runtime/node" "$BASE/app/dist/bundle.js" "$@"
```

- [ ] **Step 4: Update smoke test `scripts/package-smoke.mjs`**

Update `package-smoke.mjs` to execute against `bundle.js`, verifying database initialization, template discovery, and CLI execution.

---

### Task 4: Author Automated Benchmark & Audit Suite

**Files:**
- Create: `benchmarks/package-benchmark.mjs`

- [ ] **Step 1: Write `benchmarks/package-benchmark.mjs`**

The script extracts the built package and prints an empirical markdown table with:
1. File Count (Target: < 15 files)
2. Extracted Disk Size (Target: < 90MB)
3. Extraction Time (Target: < 0.5s)
4. Cold Startup Latency (Target: < 250ms)

- [ ] **Step 2: Run benchmark on Windows build**

Run:
```powershell
node benchmarks/package-benchmark.mjs
```
Verify all 4 metrics meet or exceed the acceptance criteria.

---

### Task 5: End-to-End Build & Multi-Platform Verification

**Files:**
- Output: `build/windows/cube-windows-x64.zip`
- Output: `build/windows/latest.json`
- Output: `build/windows/install.ps1`

- [ ] **Step 1: Run full packaging script**

Run:
```powershell
pnpm package:app
```
Verify archive creation, SHA-256 calculation, and smoke test pass.

- [ ] **Step 2: Verify live execution from packaged artifact**

Extract `cube-windows-x64.zip` to a clean temporary directory and execute:
```powershell
& ".\cube.cmd" --version
```
Verify instantaneous startup with zero system freeze.

- [ ] **Step 3: Commit all changes and verify clean git status**

Commit all changes to `feature/build-package`.
