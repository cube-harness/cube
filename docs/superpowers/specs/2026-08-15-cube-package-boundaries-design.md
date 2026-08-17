# Cube Package Boundaries and Runtime Flow Design

**Date:** 2026-08-15  
**Status:** Conversation-approved, pending written-spec review

## Purpose

Clean the current relationship between `cube-workspace`, `cube-agent`, `cube-tui`, and `cube-cli` so each package has one clear responsibility and the current phase does not need another boundary refactor later.

This phase also replaces the stale root README with an accurate high-level description of the four packages and their communication flow. The README must describe package responsibilities and runtime flow, not inventory internal files or advertise unfinished features.

## Goals

- Make `cube-cli` the only executable and composition root.
- Replace `cube-agent` import-time initialization with an explicit runtime factory.
- Keep `cube-tui` presentation-only and independent of Mastra and the other Cube packages.
- Make `cube-workspace` the source of workspace identity and global Cube filesystem/configuration state.
- Make startup, input, session-event rendering, cancellation, and shutdown follow one traceable flow.
- Give every implemented slash command one dedicated handler file and one central registry entry.
- Keep the existing global model configuration behavior and current thread lifecycle semantics unchanged.
- Standardize new implementation code on arrow functions, except custom pi-tui components that must extend a class.
- Give the prompt editor a blinking vertical hardware caret.
- Remove the unapproved custom tool approval orchestration without replacing it in this phase.
- Preserve every zero-byte placeholder file reserved for later phases.

## Non-goals

- Redesign tool execution, tool approval, or suspension resumption.
- Change model catalog discovery, provider adapters, model switching semantics, memory policy, or lazy thread creation.
- Add MCP behavior, new commands, new agents, credential storage, file locking, binary installers, or other future features.
- Move Mastra Session ownership into the TUI.
- Add a shared cross-package event bus or a new common-types package.
- Reorganize packages or document every source file.

## Chosen Architecture

`cube-cli` is the composition root. It loads process-level inputs, obtains workspace state, creates the agent runtime through `cube-agent`, creates the UI through `cube-tui`, and maps communication between them.

```text
cube-workspace
      ▲
      │
cube-agent       cube-tui
      ▲             ▲
      └── cube-cli ─┘
```

The permitted package dependencies are:

- `cube-workspace` depends on no other Cube package.
- `cube-agent` depends on `cube-workspace`.
- `cube-tui` depends on no other Cube package.
- `cube-cli` depends on `cube-workspace`, `cube-agent`, and `cube-tui`.

There is no dependency from `cube-tui` to `cube-agent`, and neither `cube-agent` nor `cube-workspace` may depend on `cube-cli` or `cube-tui`.

## Package Ownership

### `cube-workspace`

Owns persistent Cube state and workspace identity:

- `~/.cube` path layout and default-file initialization.
- Reading and writing global `config.yaml`.
- Reading `SOUL.md`.
- Workspace canonicalization and trust state.
- Stable workspace `resourceId` derivation.

`WorkspaceIdentity`, `createWorkspaceResourceId`, and `resolveWorkspaceIdentity` move from `cube-agent` to this package. Identity is based on the canonical workspace path and remains stable across sessions. It is not thread-owned state.

This package does not initialize Mastra, inspect UI state, load `.env`, or exit the process.

### `cube-agent`

Owns the headless Mastra runtime:

- Model resolution and provider integration.
- Mastra logger, storage, memory, agent workspace, Agent, AgentController, and Session creation.
- Session model operations and available-model lookup.
- Observational-memory finalization.
- Runtime resource cleanup.

The package exports an explicit arrow-function factory rather than initialized singletons:

```ts
export const createCubeRuntime = async (input: CreateCubeRuntimeInput) => {
  // Construct and initialize the Mastra runtime here.
};
```

The input makes external state explicit:

```ts
export interface CreateCubeRuntimeInput {
  config: CubeConfig;
  identity: WorkspaceIdentity;
  cubePaths: CubePaths;
  readInstructions: () => string;
}
```

`cube-cli` supplies `readInstructions` using the `cube-workspace` SOUL reader. The factory generates its session ID internally, initializes storage and the controller, then creates the Session.

The returned `CubeRuntime` facade exposes only what the CLI needs:

- `session`
- `listAvailableModels()`
- `finalizeThreadMemory(threadId)`
- `close()`

The CLI calls the factory; it does not construct Mastra internals itself. `cube-agent` must not load `.env`, call `process.cwd()` to choose the workspace, call `process.exit()`, or import TUI types.

If initialization fails after storage has been opened, the factory closes the partially created resources before rejecting. `close()` is safe to call through the CLI's idempotent shutdown path.

### `cube-tui`

Owns terminal presentation and keyboard interaction:

- pi-tui components, layout, focus, pickers, loaders, message rendering, theme, and terminal lifecycle.
- Structural view models for information that the CLI asks it to render.
- User actions emitted to the CLI.

It must not import `@cube/agent`, `@cube/workspace`, or Mastra types. Its package dependency and TypeScript project reference to `cube-agent` are removed.

The public callback vocabulary becomes UI-specific:

```ts
export type TuiAction =
  | { type: "prompt_submit"; content: string }
  | {
      type: "command_submit";
      name: `/${string}`;
      argument: string;
    }
  | { type: "cancel" };
```

`TuiInputEvent` becomes `TuiAction`, and `onEvent` becomes `onAction`. On editor submission, the TUI performs only lexical classification: ordinary text emits `prompt_submit`, while text beginning with `/` is split into a command `name` and the remaining `argument` and emits `command_submit`. The TUI does not validate the command or run its handler.

`TuiRenderEvent` and its `unknown` payload are removed in favor of named render methods such as `setInfo`, `setModel`, and `renderAgentDisplay`. `TuiSlashCommand` becomes `SlashCommandSuggestion` and contains only `{ name, description }` for autocomplete.

The TUI receives plain structural render data. It does not receive a Session, Controller, Mastra event, or runtime facade. Existing tool-related presentation components may remain untouched for the future tool phase, but this cleanup does not connect them to an approval workflow.

Production TUI code does not terminate the process or infer the active workspace with `process.cwd()`. The CLI passes the canonical workspace path for editor filesystem autocomplete. The banner uses its packaged/embedded presentation data instead of probing the caller's working directory.

### `cube-cli`

Owns application composition and process lifecycle:

- Load `.env` before runtime creation.
- Ensure Cube home state exists, read global config, resolve workspace identity, and assemble runtime input through `cube-workspace`.
- Call `createCubeRuntime(...)` from `cube-agent`.
- Create `cube-tui` and pass the canonical workspace path.
- Subscribe once to Mastra Session events.
- Convert Session state/events into plain TUI view data.
- Route `prompt_submit` to `session.followUp()`, `command_submit` to the slash-command registry, and `cancel` to abort or shutdown logic.
- Persist global model changes through `cube-workspace`.
- Handle `/exit`, SIGTERM, fatal errors, and idempotent graceful shutdown.

The slash-command registry is the single registration point for command names, descriptions, and handlers. The TUI receives only the registry's `SlashCommandSuggestion[]` projection for autocomplete.

## Slash-command Architecture

Each implemented command owns its complete behavior in one dedicated file under `cube-cli/src/slash-commands`. The current phase uses the existing filenames and preserves all zero-byte future-command placeholders unchanged.

- `model.slash-command.ts` exports an arrow-function handler factory such as `createModelCommandHandler(...)`. Its returned handler owns picker/catalog orchestration, model switching, global config persistence, and the resulting system message.
- `exit.slash-command.ts` exports `createExitCommandHandler(...)`. Its returned handler calls the injected graceful shutdown function.
- `compact.slash-command.ts` exports `createCompactCommandHandler(...)`. Its returned handler owns thread checks, active-turn checks, memory finalization, and the resulting system message.
- `registry.ts` imports those handler factories, binds their command-specific dependencies, and registers each `{ name, description, handler }` entry. It contains no command-specific business logic.

The shared contract is:

```ts
export type SlashCommandHandler = (argument: string) => Promise<void>;

export interface SlashCommandDefinition {
  name: `/${string}`;
  description: string;
  handler: SlashCommandHandler;
}
```

`createSlashCommandRegistry(...)` returns:

- `execute(name, argument)`, used only by `cube-cli` action routing. It resolves any registered command, reports an unknown name, and invokes the matching handler.
- `suggestions`, derived from registered definitions as `{ name, description }[]` and passed to `cube-tui`.

The TUI never imports command files or receives handlers. Typing `/` displays all registered suggestions; prefix input such as `/m` is filtered by pi-tui autocomplete. A zero-byte future command does not appear until it has an implemented handler and a registry entry.

## Runtime Flow

### Startup

```text
process starts
  -> cube-cli loads .env
  -> cube-cli initializes/reads cube-workspace state
  -> cube-cli resolves the current workspace identity
  -> cube-cli calls createCubeRuntime(...)
  -> cube-agent initializes the Mastra runtime and Session
  -> cube-cli creates cube-tui
  -> cube-cli subscribes once to Session events
  -> cube-cli starts the TUI
```

There are no `cube-agent` import-time side effects. This removes dynamic-import ordering as the mechanism for ensuring `.env` is loaded first.

### User input

```text
PromptEditor
  -> ordinary text: TuiAction { type: "prompt_submit", content }
      -> cube-cli -> Session.followUp({ content })
  -> slash text: TuiAction { type: "command_submit", name, argument }
      -> cube-cli -> commandRegistry.execute(name, argument)
          -> matching per-command handler
          -> system message when name is unknown
```

The CLI adds the submitted user message to the TUI before awaiting `followUp()`. The Session remains the source of agent execution state; the TUI does not infer whether the agent is working from prompt submission alone.

### Agent output

```text
Mastra Session event
  -> the single cube-cli Session subscription
  -> cube-cli maps Session/display state to plain view data
  -> cube-tui render methods
  -> pi-tui components
```

`display_state_changed` remains the source for assistant streaming state, running state, and passive tool display. `model_changed`, `info`, and `error` continue to be mapped by the CLI to the relevant TUI updates. The TUI does not subscribe directly to the Session.

### Model switching

The existing model flow is preserved:

```text
/model
  -> cube-cli command handler
  -> model catalog lookup through runtime/provider helpers
  -> cube-tui picker
  -> Session model switch with global scope
  -> global config.yaml persistence
```

Model selection is global configuration, not thread-owned configuration. This cleanup must not restore per-thread model persistence or change catalog/provider behavior.

## Cancellation and Shutdown

Only `cube-cli` may decide to terminate the application.

- When the model picker or a future approval picker is focused, Escape or Ctrl+C closes that inline control and restores prompt focus. The key is consumed and does not exit.
- When no picker consumes Ctrl+C, `cube-tui` emits `{ type: "cancel" }`.
- If `session.run.isRunning()` is true, `cube-cli` calls `session.abort()` and keeps the application open.
- If the Session is idle, the same action triggers graceful shutdown.
- `/exit` and SIGTERM always trigger graceful shutdown.

Shutdown is idempotent and ordered:

```text
stop accepting/rendering interactive input
  -> stop TUI and restore terminal cursor state
  -> close Cube runtime/storage
  -> exit from cube-cli
```

Repeated shutdown requests reuse the same in-flight shutdown promise. No TUI component calls `process.exit()`.

## Prompt Editor and Cursor

`PromptEditor` becomes a custom class extending pi-tui `Editor`, because the required cursor behavior needs a render-level customization. Other factories, handlers, mappers, and bootstrap functions remain arrow-function exports.

The editor uses the terminal's hardware cursor as a blinking vertical caret:

- Enable hardware cursor rendering through the TUI.
- Set the terminal cursor style to blinking bar (`CSI 5 SP q`) while the app is active.
- Preserve pi-tui's cursor marker so the terminal cursor is positioned correctly.
- Suppress the editor's fake inverse-video software cursor at that marker.
- Restore the terminal's default cursor style (`CSI 0 SP q`) when the app stops, including graceful shutdown after errors.

No interval/timer is introduced for blinking. Cursor blinking is delegated to the terminal.

The editor constructor receives the autocomplete base path explicitly. It does not default to `process.cwd()` in production code.

The unnamed container immediately below the prompt remains part of the layout because it hosts inline loaders and pickers. It is renamed from `inlineControls` to `inlineControlHost` to make that role explicit.

## Tool Approval Boundary for This Phase

Tool behavior is intentionally deferred.

This cleanup removes:

- `cube-cli/src/approval-flow.ts`
- its focused test
- the `runApprovalFlow` import and invocation
- `handledApprovalId`
- the custom popup-triggering and deduplication derived from `display_state_changed`

It does not add a replacement approval flow. In particular, this phase does not introduce approval polling, a custom approval state reducer, or provider/tool-name checks. A later tool phase must use Mastra's typed approval/suspension Session events and direct Session response APIs.

Passive tool rendering that already comes from Session display state may remain, including a waiting status that is already present in the snapshot. It must not open a picker or send an approval response. Existing TUI approval presentation code is not treated as a working end-to-end approval feature in this phase.

## Error Handling

- Failures before the TUI starts are reported once by `cube-cli`, followed by cleanup of any partially created runtime resources and a non-zero exit.
- Errors emitted by a live Session are mapped by `cube-cli` to a system message in the TUI.
- A rejected prompt, command, model switch, or catalog request is shown in the TUI without bypassing runtime cleanup.
- Fatal errors after TUI startup use the same graceful shutdown path so terminal cursor state and storage are restored.
- Packages throw or return errors to their caller; lower-level packages do not terminate the process.

## Dependency and Script Cleanup

- Remove `@cube/agent` from `cube-tui/package.json`.
- Remove the `cube-agent` project reference from `cube-tui/tsconfig.json`.
- Keep only the approved one-way Cube dependency graph.
- Remove or correct scripts that reference nonexistent entrypoints; specifically, `cube-tui` must not advertise a `dev` script for a missing `src/dev.ts`.
- Do not upgrade unrelated library versions as part of this cleanup.
- Regenerate the pnpm lockfile only as required by manifest changes.

## README Scope

The root README will contain:

- A short, accurate statement of Cube's current purpose.
- The high-level responsibility of each of the four packages.
- The one-way dependency diagram.
- Startup, input, output, model-switch, and shutdown flow at overview level.
- Current development commands derived from root package scripts and the actual Node engine requirement.

The README will not list internal package files or claim support for `taskey`, credentials/keychain storage, file locks, completed MCP client/server behavior, production binary installers, or any other unimplemented feature.

## Testing and Verification

### Package tests

- `cube-workspace`: workspace identity canonicalization and stable `resourceId` behavior after moving ownership.
- `cube-agent`: runtime factory construction/cleanup boundaries using injected inputs where practical; existing model and memory tests remain unchanged.
- `cube-tui`: typed `prompt_submit`, `command_submit`, and `cancel` emission; command name/argument splitting; suggestion autocomplete; Ctrl+C behavior; picker cancellation; explicit autocomplete base path; `PromptEditor` cursor marker behavior; and cursor-style restoration.
- `cube-cli`: Session-to-view mapping; exhaustive TUI action routing; registry execution and unknown-command behavior; isolated model, exit, and compact handlers; idempotent shutdown; model persistence wiring; and removal of the custom approval-flow path.

### Repository verification

Run, in order:

1. Peer/dependency validation.
2. All package tests.
3. TypeScript project build/typecheck for all four packages.
4. JavaScript syntax check of the built CLI entrypoint.
5. A focused CLI smoke check that startup uses global config and does not initialize `cube-agent` before `.env` loading.
6. Existing provider/model runtime smoke checks when the required local service or API key is available.

Verification must use fresh build outputs so stale `dist` or `*.tsbuildinfo` files cannot mask source errors. Environment-dependent provider checks are reported separately from deterministic unit/build results.

## Acceptance Criteria

- The package dependency graph matches the chosen architecture exactly.
- Importing `@cube/agent` has no runtime side effects; runtime creation occurs only through `createCubeRuntime(...)`.
- `cube-cli` is the only composition root and the only package that exits the process.
- `cube-tui` imports no Cube package or Mastra type and never derives production workspace state from the process.
- Workspace identity and `resourceId` are owned by `cube-workspace` and remain workspace-global.
- One CLI Session subscription maps agent output to structural TUI rendering.
- `TuiAction` has distinct `prompt_submit`, `command_submit`, and `cancel` variants; `cube-cli` routes them without re-parsing raw submitted text.
- Every implemented slash command has a dedicated handler file and exactly one central registry entry; `/` autocomplete is derived from those entries, while unimplemented zero-byte commands remain hidden.
- Ctrl+C aborts an active run, exits gracefully when idle, and closes an active picker without exiting.
- The prompt caret is a blinking hardware `|`, and terminal cursor state is restored on stop.
- `approval-flow.ts`, its test, and its custom CLI state are removed without adding a replacement tool-approval implementation.
- All zero-byte future-phase placeholders remain present and unchanged.
- The README describes only the implemented four-package architecture and current commands.
- Deterministic tests and builds pass from fresh artifacts; any unavailable external smoke check is identified rather than treated as passed.
