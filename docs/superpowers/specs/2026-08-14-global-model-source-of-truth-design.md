# Global Model Source of Truth

## Decision

`~/.cube/config.yaml` is the only durable source of truth for the active model.
Thread metadata stores conversation state and must not determine which model Cube
uses after startup.

## Ownership

- `config.yaml.model` owns the globally selected model across Cube restarts and
  workspaces.
- `session.model` is the runtime copy used by the active Mastra session.
- `/model` changes both the runtime selection and `config.yaml.model`.
- Mastra thread metadata may contain framework-managed model fields, but Cube
  does not treat those fields as authoritative.

## Startup Flow

1. Cube loads `.env`.
2. Cube reads `config.yaml`.
3. Cube creates and hydrates the Mastra session and its most recent thread.
4. After hydration, Cube explicitly applies `config.yaml.model` to
   `session.model` with global scope.
5. The TUI reads the resulting session model, which therefore matches the
   configured global model.

This ordering prevents `modeModelId_default` or `currentModelId` from an older
thread from overriding the global configuration.

## Model Switching

`/model` continues to use global scope. A successful switch updates the live
session first and then writes the selected model to `config.yaml`. Cube does not
switch with thread scope and does not intentionally persist model selection as
thread-owned state.

If switching fails, Cube leaves both the current runtime model and
`config.yaml` unchanged.

## Compatibility

Existing threads and conversation history are preserved. No database migration
or metadata deletion is required. Framework-managed model metadata can remain
in old threads because startup reconciliation makes it non-authoritative.

## Verification

- A regression test starts with a hydrated session model different from the
  configured model and verifies that startup reconciliation selects the
  configured model.
- Existing `/model` tests continue to verify that failed switches are not
  persisted.
- The full monorepo test suite and TypeScript build must pass.
- A runtime smoke check must show identical values for `config.model` and
  `session.model.get()` after Cube initializes, even when the active thread has
  stale model metadata.
