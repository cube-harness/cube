# Cube Workspace Home and Runtime Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current low-level `cube-workspace` barrel API with one Cube-home facade, scoped agent runtime paths, recoverable config/SOUL validation, and immutable per-thread SOUL instructions.

**Architecture:** `cube-workspace/src/index.ts` creates one `createCubeWorkspace()` facade backed by `home.ts` and `identity.ts`. Bootstrap templates live together under `src/cube-home`; runtime-created memory and log files remain owned by `cube-agent`, which receives only `AgentRuntimeFiles`. `cube-agent` snapshots SOUL into Mastra thread settings before the first prompt and resolves all later system instructions from that persisted setting.

**Tech Stack:** TypeScript 5.7, Node.js 22 filesystem APIs, Zod 4.4.3, YAML 2.7, Mastra AgentController Session 1.56, pnpm

## Global Constraints

- Use arrow functions for new production functions.
- `cube-workspace/src/index.ts` is the main composition module, not a low-level re-export barrel.
- Do not create `config.ts`, `soul.ts`, or `mcp.ts` files containing thin CRUD wrappers.
- Keep all source-controlled `~/.cube` bootstrap files under `cube-workspace/src/cube-home/`.
- Do not create `skills/` or `plugins/`; do not delete an existing user `~/.cube/skills` directory.
- Tests added by this plan live outside production `src` directories.
- Do not restore tests deleted by the user.
- Run tests, builds, syntax checks, and smoke checks only in the final verification task.
- Expected user-correctable errors return typed results and never terminate the application.
- Existing user bootstrap files are never overwritten during initialization.
- `SOUL.md` is read only when a thread needs its immutable initial snapshot.

---

### Task 1: Build the Cube-home facade and packaged template tree

**Files:**
- Create: `cube-workspace/src/cube-home/config.yaml`
- Create: `cube-workspace/src/cube-home/SOUL.md`
- Create: `cube-workspace/src/cube-home/workspace.json`
- Create: `cube-workspace/src/cube-home/mcp.json`
- Create: `cube-workspace/src/home.ts`
- Create: `cube-workspace/src/identity.ts`
- Modify: `cube-workspace/src/schemas/config.schema.ts`
- Replace: `cube-workspace/src/index.ts`
- Delete: `cube-workspace/src/config.ts`
- Delete: `cube-workspace/src/workspace.ts`
- Delete: `cube-workspace/src/defaults/config.defaults.ts`
- Delete: `cube-workspace/defaults/config.yaml`
- Delete: `cube-workspace/defaults/SOUL.md`
- Delete: `cube-workspace/defaults/workspace.json`
- Delete: `cube-workspace/defaults/mcp.json`

**Interfaces:**
- Produces: `createCubeWorkspace(options?: { home?: string }): CubeWorkspace`
- Produces: `CubeResult<T>`, `CubeConfig`, `WorkspaceIdentity`, and `AgentRuntimeFiles`
- Consumes: the current config values, SOUL contents, workspace registry template, MCP template, identity hashing rules, and `config.soul.max_characters = 20000`

- [x] **Step 1: Move the four bootstrap templates into the mirrored Cube-home tree**

Create `src/cube-home/config.yaml` from the current template and add:

```yaml
soul:
  max_characters: 20000
```

Move the existing non-empty `SOUL.md`, `{ "version": 1, "workspaces": [] }`, and `{ "mcpServers": {} }` templates without changing their semantic content. Do not create skills or plugin directories.

- [x] **Step 2: Keep the config schema validation-only and add SOUL limits**

Extend `ConfigSchema` with:

```ts
soul: z.object({
  max_characters: z.number().int().min(1).max(1_000_000),
}).strict(),
```

Keep compatibility defaults already present in nested memory fields, but remove all imports or exports of `DEFAULT_CONFIG`.

- [x] **Step 3: Implement the central Cube-home domain in `home.ts`**

Define the exact boundary types:

```ts
export type CubeResult<T> =
  | { ok: true; value: T; warning?: string }
  | { ok: false; error: string };

export interface AgentRuntimeFiles {
  memoryDatabase: string;
  sessionLog: (sessionId: string) => string;
}

export interface CubeHome {
  initialize: () => void;
  config: {
    read: () => CubeResult<CubeConfig>;
    write: (config: CubeConfig) => CubeResult<CubeConfig>;
  };
  soul: {
    snapshot: () => CubeResult<string>;
  };
  agentRuntime: AgentRuntimeFiles;
}
```

`createCubeHome(home, templateRoot = new URL("./cube-home/", import.meta.url))` must:

- create only `home`, `memories`, and `logs` directories;
- validate the packaged config before exclusive template creation;
- exclusively copy all four bootstrap files without overwriting user files;
- parse user config and return the packaged config plus a warning when the user file is invalid;
- validate writes before YAML serialization;
- recreate a missing SOUL template;
- return packaged SOUL plus a warning for whitespace-only user content;
- reject oversized SOUL as `{ ok: false, error }` without truncating;
- use `statSync` to reject files over `maxCharacters * 4` bytes before reading, then count Unicode code points with `Array.from(content).length`;
- expose `memoryDatabase` as `path.join(home, "memories", "memory.sqlite")`;
- expose `sessionLog(sessionId)` under `path.join(home, "logs")` using the exact filename pattern `agent-<sessionId>.json`;
- expose no other Cube-home path to the agent.

Use template paths relative to `home.ts` so source execution resolves `src/cube-home` and built execution resolves `dist/cube-home`.

- [x] **Step 4: Move workspace identity into `identity.ts`**

Preserve the existing behavior and signatures internally:

```ts
export interface WorkspaceIdentity {
  canonicalPath: string;
  resourceId: string;
}

export const resolveWorkspaceIdentity = (workspacePath: string): WorkspaceIdentity => {
  const canonicalPath = realpathSync.native(path.resolve(workspacePath));
  return {
    canonicalPath,
    resourceId: createWorkspaceResourceId(canonicalPath),
  };
};
```

Retain Windows case-insensitive identity hashing and POSIX case-sensitive behavior.

- [ ] **Step 5: Replace the barrel entry with the main facade factory**

`src/index.ts` imports `createCubeHome` and the identity resolver, creates the default home at `path.join(os.homedir(), ".cube")`, and returns:

```ts
export const createCubeWorkspace = (
  options: { home?: string } = {},
) => {
  const home = createCubeHome(options.home ?? path.join(os.homedir(), ".cube"));
  return {
    initialize: home.initialize,
    config: home.config,
    soul: home.soul,
    identity: { resolve: resolveWorkspaceIdentity },
    agentRuntime: home.agentRuntime,
  };
};
```

Export this factory and only the boundary types required by `cube-agent` and `cube-cli`. Do not re-export raw filesystem helpers.

- [ ] **Step 6: Remove obsolete source and package-level defaults**

Delete the old low-level modules and both old default locations only after every semantic value and active identity function is represented in the new files. Preserve unrelated user files.

### Task 2: Make asset packaging and cleanup deterministic

**Files:**
- Create: `cube-workspace/scripts/copy-cube-home.mjs`
- Create: `cube-workspace/scripts/clean.mjs`
- Modify: `cube-workspace/package.json`

**Interfaces:**
- Consumes: `cube-workspace/src/cube-home/`
- Produces: `cube-workspace/dist/cube-home/` with exactly four files

- [x] **Step 1: Implement a scoped asset-copy script**

Use Node filesystem APIs and paths derived from `import.meta.url`:

```js
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(packageRoot, "src", "cube-home");
const target = path.join(packageRoot, "dist", "cube-home");

rmSync(target, { recursive: true, force: true });
mkdirSync(path.dirname(target), { recursive: true });
cpSync(source, target, { recursive: true, errorOnExist: false, force: true });
```

The target is fixed under this package; do not accept a caller-provided delete path.

- [x] **Step 2: Replace the broken rimraf cleanup**

`clean.mjs` resolves only `dist` and `tsconfig.tsbuildinfo` under `cube-workspace` and removes them with `rmSync(..., { recursive: true, force: true })`. It accepts no path arguments.

- [x] **Step 3: Wire package scripts**

Update scripts to:

```json
{
  "build": "tsc --build && node scripts/copy-cube-home.mjs",
  "clean": "node scripts/clean.mjs",
  "test": "tsx --test --test-isolation=none tests/**/*.test.ts"
}
```

Do not add `rimraf` or a new copy dependency.

### Task 3: Give `cube-agent` scoped files and immutable thread SOUL

**Files:**
- Create: `cube-agent/src/session-soul.ts`
- Modify: `cube-agent/src/agents/default.agent.ts`
- Modify: `cube-agent/src/index.ts`
- Modify: `cube-agent/src/logger.ts`

**Interfaces:**
- Consumes: `CubeConfig`, `WorkspaceIdentity`, `AgentRuntimeFiles`, `CubeResult<string>`
- Produces: `CubeRuntime.preparePrompt(): Promise<CubeResult<void>>`
- Preserves: the public Session for subscription, model operations, abort, and thread navigation

- [x] **Step 1: Replace the broad runtime input**

Change the runtime input to:

```ts
export interface CreateCubeRuntimeInput {
  config: CubeConfig;
  identity: WorkspaceIdentity;
  runtimeFiles: AgentRuntimeFiles;
  loadSoul: () => CubeResult<string>;
}
```

Use `runtimeFiles.memoryDatabase` for `LibSQLStore` and pass only `runtimeFiles.sessionLog` to the logger. Remove every `CubePaths` dependency from `cube-agent`.

- [x] **Step 2: Implement thread SOUL preparation**

In `session-soul.ts`, define `SOUL_SETTING_KEY = "cube.soul"` and an arrow-function factory that receives the Session plus `loadSoul`.

`preparePrompt()` must:

1. If an active thread exists, read `session.thread.getSetting({ key: SOUL_SETTING_KEY })`.
2. Return success immediately when the stored value is a non-empty string.
3. Otherwise call `loadSoul()` once.
4. Return its error without creating a thread.
5. Create a thread only when none is active and SOUL loading succeeded.
6. Persist the string using `session.thread.setSetting(...)`.
7. If persistence fails for a newly created thread, delete that thread and return an error.
8. Preserve and return any fallback warning from `loadSoul()`.

Expose a second helper that retrieves the persisted string and creates a Mastra `RequestContext` containing the same `cube.soul` key for the run.

- [x] **Step 3: Resolve agent instructions only from RequestContext**

Replace the file-reading callback with a dynamic instructions resolver:

```ts
export const createSoulInstructions = () =>
  ({ requestContext }: { requestContext: RequestContext }) => {
    const instructions = requestContext.get("cube.soul");
    if (typeof instructions !== "string" || !instructions.trim()) {
      throw new Error("Thread SOUL instructions are unavailable.");
    }
    return instructions;
  };
```

The resolver must never call the workspace or read `SOUL.md`.

- [x] **Step 4: Add the runtime prompt-preparation boundary**

Extend `CubeRuntime` with:

```ts
preparePrompt: () => Promise<CubeResult<void>>;
followUp: (content: string) => Promise<void>;
```

`followUp()` reads only the active thread's persisted SOUL, constructs the request context, and calls `session.followUp({ content, requestContext })`. It does not read the file and fails clearly if `preparePrompt()` was not completed.

### Task 4: Migrate `cube-cli` to the main facade and recoverable prompt flow

**Files:**
- Modify: `cube-cli/src/index.ts`
- Modify: `cube-cli/src/slash-commands/model.slash-command.ts` only if its persistence dependency type needs adaptation
- Modify: `cube-cli/src/slash-commands/registry.ts` only if factory dependency typing needs adaptation

**Interfaces:**
- Consumes: `createCubeWorkspace()` and `CubeRuntime.preparePrompt()/followUp()`
- Removes: direct imports of paths and low-level workspace functions

- [x] **Step 1: Replace low-level workspace imports**

Startup becomes:

```ts
const workspace = createCubeWorkspace();
workspace.initialize();
const configResult = workspace.config.read();
```

Use `configResult.value` when successful and queue its warning for display after the TUI exists. Resolve identity through `workspace.identity.resolve(process.cwd())`. Pass `workspace.agentRuntime` and `workspace.soul.snapshot` to `createCubeRuntime()`.

- [x] **Step 2: Route model persistence through the facade**

Replace `writeConfig(..., paths)` with `workspace.config.write(...)`. Render an error result instead of throwing or silently claiming success. Preserve global Session model switching behavior.

- [x] **Step 3: Prepare the thread before rendering/submitting a prompt**

The `prompt_submit` action becomes:

```ts
const prepared = await activeRuntime.preparePrompt();
if (!prepared.ok) {
  showSystemMessage(prepared.error);
  return;
}
if (prepared.warning) showSystemMessage(prepared.warning);
app?.addMessage({ role: "user", content: action.content });
await activeRuntime.followUp(action.content);
```

This keeps oversized SOUL errors in the UI, leaves the app running, and creates neither a fake user message nor a new thread on preparation failure.

- [x] **Step 4: Remove expected-error process termination paths**

Keep action errors and Session error events mapped to TUI system messages. Fatal infrastructure failures must still stop the TUI, close the runtime, restore terminal state, print one concise message when the TUI never started, and set `process.exitCode = 1` instead of leaking an unhandled rejection or stack trace.

### Task 5: Add external tests for the new behavior

**Files:**
- Create: `cube-workspace/tests/home.test.ts`
- Create: `cube-workspace/tests/identity.test.ts`
- Create: `cube-agent/tests/session-soul.test.ts`
- Modify: `cube-agent/package.json`

**Interfaces:**
- Tests: real temporary directories and real `Session.thread`-shaped fakes without mocking filesystem behavior
- Does not restore: any deleted colocated test file

- [x] **Step 1: Add Cube-home behavior tests outside `src`**

Cover these exact cases in `home.test.ts`:

- initialization creates four bootstrap files, `memories`, and `logs`;
- initialization creates no skills or plugins directory;
- a second initialization preserves edits to all four files;
- invalid user config returns packaged config plus warning and preserves the invalid file;
- valid config writes validate and persist;
- missing SOUL is recreated;
- whitespace SOUL returns packaged fallback plus warning without changing the user file;
- a SOUL over 20,000 Unicode code points returns an error without truncation;
- `agentRuntime` exposes the correct memory database and session log paths.

- [x] **Step 2: Preserve identity behavior tests outside `src`**

Cover canonical path resolution, stable SHA-256 resource IDs, Windows case folding, and POSIX case sensitivity in `identity.test.ts`.

- [x] **Step 3: Add thread SOUL tests outside agent source**

Cover:

- failed SOUL validation creates no thread;
- first valid prompt creates one thread and persists `cube.soul`;
- later preparation reuses metadata without calling `loadSoul`;
- switching to an old thread uses its stored content;
- a legacy thread captures exactly once;
- setting persistence failure deletes the newly created thread;
- request context contains the persisted string.

- [x] **Step 4: Point agent tests at the external test tree**

Update `cube-agent/package.json` to:

```json
{
  "test": "tsx --test --test-isolation=none tests/**/*.test.ts"
}
```

The package currently has no source tests, so this does not hide an existing suite. Do not move unrelated tests in other packages during this phase.

### Task 6: Final verification from clean artifacts

**Files:**
- Verify: all modified source, tests, scripts, package manifests, and built output

**Interfaces:**
- Confirms: package boundaries, recoverable errors, immutable SOUL, asset packaging, and consumer compatibility

- [x] **Step 1: Run the complete existing and new test set**

Run each package test script that has source tests and record exact pass/fail counts. Tests must include the new workspace and agent external suites plus existing CLI and TUI suites.

- [x] **Step 2: Clean and build all packages**

Run the new workspace clean script, remove only verified package-local stale build metadata where required, then run:

```powershell
pnpm run build
```

If pnpm fails with sandbox `spawn EPERM`, rerun the identical build with approved elevated execution before treating it as a source failure.

- [x] **Step 3: Verify built assets and JavaScript syntax**

Confirm `cube-workspace/dist/cube-home/` contains exactly `config.yaml`, `SOUL.md`, `workspace.json`, and `mcp.json`. Run:

```powershell
node --check cube-workspace/dist/index.js
node --check cube-agent/dist/index.js
node --check cube-cli/dist/index.js
```

- [x] **Step 4: Run a temporary-home Cube workspace smoke test**

Using the built package API, initialize a unique temporary home under `D:\cube`, verify no skills/plugins are created, verify config fallback and SOUL fallback/limit behavior, verify reinitialization does not overwrite edits, and remove only the validated temporary directory afterward.

- [x] **Step 5: Run a focused thread SOUL runtime smoke test**

Create the real Cube runtime with its local LibSQL storage but do not invoke a model. Call `preparePrompt()`, inspect the persisted active-thread `cube.soul` setting, edit `SOUL.md`, and call `preparePrompt()` again to verify the active thread keeps its original value. Clear/create a new thread through the Session API, prepare again, and verify the new thread receives the edited value. Provider generation is outside this deterministic smoke check.

- [x] **Step 6: Audit final ownership and stale references**

Use `rg` to confirm:

- no `CubePaths`, `readConfig`, `writeConfig`, `readSoul`, `ensureCubeHome`, or `DEFAULT_CONFIG` consumer remains;
- no package-level `cube-workspace/defaults/` or `src/defaults/` remains;
- `cube-agent` imports only boundary types from `@cube/workspace`;
- no production code creates `skills` or `plugins`;
- the dynamic instructions resolver never reads `SOUL.md`;
- no expected user-input error calls `process.exit()`.

Git integration is skipped when `D:\cube` is still not recognized as a Git repository; report that environment fact rather than claiming a commit.
