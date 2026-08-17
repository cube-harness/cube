# Cube Workspace Home and Runtime Boundary Design

## Goal

Redesign `cube-workspace` around one coherent `~/.cube` model instead of one
CRUD module per file. The package owns the Cube home layout, bootstrapped user
files, validation, and scoped runtime paths. Packages that generate runtime data
receive only the paths they need and continue to own that data's lifecycle.

## Source layout

```text
cube-workspace/
├── src/
│   ├── cube-home/
│   │   ├── config.yaml
│   │   ├── SOUL.md
│   │   ├── workspace.json
│   │   └── mcp.json
│   ├── schemas/
│   │   └── config.schema.ts
│   ├── index.ts
│   ├── home.ts
│   └── identity.ts
├── scripts/
│   ├── copy-cube-home.mjs
│   └── clean.mjs
└── tests/
    ├── home.test.ts
    └── identity.test.ts
```

There are no separate `config.ts`, `soul.ts`, or `mcp.ts` files containing only
thin filesystem CRUD functions. `home.ts` implements the Cube home domain as a
single unit. `identity.ts` stays separate because current-workspace identity is
not a file in the Cube home.

Tests live outside `src`. Skills and plugins are not part of this phase, so the
source tree and fresh Cube homes contain neither directory.

## Cube home entry categories

### Bootstrapped user files

The four files under `src/cube-home/` are copied or materialized into a fresh
`~/.cube` and become user-owned after creation:

- `config.yaml`
- `SOUL.md`
- `workspace.json`
- `mcp.json`

Bootstrap uses exclusive creation and never overwrites an existing user file.
`workspace.json` and `mcp.json` remain templates only in this phase; no unused
CRUD facade or per-file module is added for future behavior.

### Runtime-generated state

Runtime state has no source template but its location is still defined by
`cube-workspace`:

- `memories/memory.sqlite`
- `logs/agent-<sessionId>.json`

`cube-workspace` creates the parent directories and exposes an
`AgentRuntimeFiles` capability containing only these paths. `cube-agent` owns
creation, content, locking, and closure of the SQLite database and log files.

Unused path declarations such as `modelCatalogCache`, `workspaceLog`, and
`skillsDir` are removed. Existing user data, including a legacy
`~/.cube/skills` directory, is never deleted automatically.

## Public API and `index.ts`

`index.ts` is the package main and composition point, not a barrel of low-level
re-exports. It directly implements the `createCubeWorkspace()` factory and
exports only the factory plus public boundary types needed by consumers:

- `CubeConfig`
- `WorkspaceIdentity`
- `AgentRuntimeFiles`
- `CubeResult<T>`

The facade shape is:

```ts
export const createCubeWorkspace = (options = {}) => ({
  initialize,
  config: {
    read,
    write,
  },
  soul: {
    snapshot,
  },
  identity: {
    resolve,
  },
  agentRuntime,
});
```

Config reads/writes and SOUL snapshot creation return typed results for expected
user-correctable failures. `initialize()` performs package-integrity bootstrap;
missing packaged assets and other infrastructure failures are caught by the CLI
startup boundary.

Low-level functions such as `readConfig`, `writeConfig`, `createCubePaths`,
`ensureCubeHome`, and raw target paths are internal and are not exported from
the package main.

## Configuration

`src/cube-home/config.yaml` is the only source of default config values.
`src/schemas/config.schema.ts` owns validation and the inferred `CubeConfig`
type. The separate TypeScript `DEFAULT_CONFIG` object and its public export are
removed.

Configuration adds the following field:

```yaml
soul:
  max_characters: 20000
```

The schema requires a positive bounded integer. SOUL length is counted as
Unicode code points, not UTF-16 code units. Before reading, the implementation
uses the file byte size and the maximum four-byte UTF-8 representation to reject
files that are guaranteed to exceed the configured character limit without
loading an unbounded file into memory.

If the user config is invalid, Cube preserves the file, uses the validated
packaged config for the current run, and returns a warning for the CLI to show.
The next explicit config write serializes a complete valid config.

## SOUL bootstrap, validation, and fallback

The packaged `SOUL.md` always contains non-empty default instructions.

When a SOUL snapshot is requested:

1. A missing user `SOUL.md` is recreated exclusively from the packaged file.
2. A non-empty file within `config.soul.max_characters` returns its content.
3. A whitespace-only file returns the packaged default content plus a warning.
   The user file remains unchanged.
4. A file over the configured character limit returns a user-facing error. It
   is never truncated and the application remains running.

The result is explicit rather than an exception for expected user-correctable
conditions:

```ts
type Result<T> =
  | { ok: true; value: T; warning?: string }
  | { ok: false; error: string };
```

## Immutable SOUL per thread

`SOUL.md` is read only when a thread needs its initial instructions. It is not
read on every model call.

For the first prompt when the Session has no active thread:

1. `cube-agent` asks the injected workspace callback for a SOUL snapshot.
2. A failed result is returned to `cube-cli`; the CLI renders the error, does
   not add or submit the prompt, and no thread is created.
3. On success, `cube-agent` calls `session.thread.create()`.
4. It persists the exact instruction text with
   `session.thread.setSetting({ key: "cube.soul", value })`.
5. It supplies that same text in the run `RequestContext` and then calls
   `session.followUp()`.

If persisting the setting fails immediately after thread creation, the newly
created thread is deleted and the error is returned, preventing an empty thread
from being left behind by SOUL initialization.

For later prompts on the same thread, `cube-agent` reads `cube.soul` from the
active thread setting and passes it through `RequestContext`. The agent's
dynamic instructions resolver reads only this request value, never the file.

When switching to or reopening an existing thread, the persisted setting is the
source of truth. A legacy thread without `cube.soul` captures and persists one
snapshot before its next run. Editing `SOUL.md` therefore affects only threads
created or migrated afterward; an existing thread's system prompt cannot change
mid-conversation.

## Cross-package runtime flow

Startup becomes:

```text
cube-cli
  -> createCubeWorkspace()
  -> workspace.initialize()
  -> workspace.config.read()
  -> workspace.identity.resolve(process.cwd())
  -> createCubeRuntime({
       config,
       identity,
       runtimeFiles: workspace.agentRuntime,
       loadSoul: workspace.soul.snapshot
     })
```

`cube-agent` no longer receives the full `CubePaths` object. Its path capability
is limited to:

```ts
export interface AgentRuntimeFiles {
  memoryDatabase: string;
  sessionLog: (sessionId: string) => string;
}
```

`LibSQLStore` creates and owns `memory.sqlite`. The agent logger creates and owns
each session log. `cube-tui` receives no Cube-home path or Cube-home filesystem
API; its existing project base path for editor completion is unchanged.

The runtime facade owns the thread-aware prompt submission described above.
`cube-cli` does not duplicate SOUL metadata or `RequestContext` logic; it routes
prompt actions to the runtime and renders returned user-facing errors/warnings.

## Error handling

Expected user-correctable errors are returned as typed results and displayed in
the TUI. They do not close the application:

- Invalid user config uses the packaged fallback and returns a warning.
- Empty SOUL uses packaged instructions and returns a warning.
- Oversized SOUL returns an error and blocks only thread creation/submission.
- Invalid prompt preparation returns an error without leaving an empty thread.

Async action errors, Session error events, provider errors, and command failures
are caught at the CLI boundary and rendered as system messages. There are no
unhandled promises or expected-input paths that call `process.exit()`.

Infrastructure errors that make continuation impossible, such as missing
packaged assets or failed storage initialization, are still caught. Cube reports
the error, closes any partially initialized runtime/TUI resources, restores the
terminal, and exits gracefully with a non-zero status rather than crashing with
an unhandled stack trace.

## Asset packaging and cleanup

TypeScript does not copy Markdown, YAML, or unimported JSON assets. The workspace
build compiles TypeScript and then copies the four files under `src/cube-home/`
to `dist/cube-home/`. Source and built execution both resolve
`./cube-home/<file>` relative to their current module directory.

The current broken `rimraf` clean script is replaced by a cross-platform Node
script using exact package-local targets. The package-level `defaults/`
directory and `src/defaults/` directory are removed.

## Verification

- Tests are stored under `cube-workspace/tests`, never beside production files.
- Verify bootstrap creates exactly the four user files plus `memories/` and
  `logs/`, with no `skills/` or `plugins/`.
- Verify bootstrap never overwrites edited config, SOUL, workspace, or MCP files.
- Verify invalid user config falls back with a warning and remains unchanged.
- Verify empty SOUL falls back without changing the user file.
- Verify oversized SOUL returns an error, leaves the app usable, and creates no
  thread.
- Verify the SOUL setting is captured once, persisted, and reused across later
  prompts and thread reopening.
- Verify changing `SOUL.md` affects a new thread but not an existing thread.
- Verify failed SOUL-setting persistence deletes the just-created empty thread.
- Verify `cube-agent` receives only `AgentRuntimeFiles` and still initializes
  storage and logging.
- Run all existing package tests, build all four packages, syntax-check the CLI,
  and run a temporary-home runtime smoke test from fresh build artifacts.
