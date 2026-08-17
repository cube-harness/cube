# Native pi-tui Input and Model Picker Design

## Objective

Replace Cube's hand-written prompt editing and slash autocomplete with the installed `@earendil-works/pi-tui@0.83.0` components, and make `/model` open an interactive, searchable model picker that switches and persists the selected session model.

## Current Problem

`cube-tui` currently uses pi-tui only for the renderer, terminal transport, component interface, and text-width helpers. It reimplements prompt editing, cursor behavior, history, key handling, and slash autocomplete in `cube-tui/src/components/input-box.ts`, although the installed package already provides `Editor` and `CombinedAutocompleteProvider`.

`/model` currently discovers models in `cube-cli/src/index.ts`, formats them as a system-message string in `cube-cli/src/slash-commands/model.slash-command.ts`, and requires the user to type `/model <model-id>`. It never creates a `SelectList` or overlay. Runtime verification on 2026-08-12 found one local Ollama model and 38 direct `google/...` Mastra models, so the missing picker is a presentation and interaction problem rather than an empty catalog.

## Approaches Considered

### 1. Native pi-tui composition on the current main-screen renderer (selected)

Use `Editor` with `CombinedAutocompleteProvider` for the prompt and a small `ModelPicker` composition built from `Input`, `SelectList`, and `TUI.showOverlay()`. Keep the custom transcript state because pi-tui does not provide a chat-specific streaming message store, but render assistant content through `Markdown` where appropriate.

This removes duplicated terminal editing logic while preserving terminal scrollback and the existing package boundaries. It is the smallest approach that satisfies both reported issues.

### 2. Add only a `SelectList` model overlay

Keep the custom `InputBox` and add a model selector. This fixes `/model` but leaves duplicated cursor, history, keybinding, paste, and autocomplete behavior. It does not satisfy the request to use the library's available components throughout the TUI.

### 3. Rebuild the application around an alternate-screen viewport

Move to an alternate-screen layout with fixed transcript/editor/footer regions and app-owned scrolling. This could support a richer full-screen experience, but changes scrollback behavior and expands the task far beyond the two current issues. It is explicitly out of scope.

## Architecture

The existing `@cube/cli` to `@cube/tui` ownership boundary remains intact:

- `@cube/cli` owns command handlers, model discovery, session switching, and persistence.
- `@cube/tui` owns terminal presentation, prompt interaction, loading state, overlays, and model selection events.
- `@cube/agent` continues to own the Mastra controller and active session.
- `@cube/workspace` continues to own persisted configuration.

`@cube/tui` must not import the Mastra controller or workspace configuration APIs. The CLI passes async callbacks and serializable picker items through the TUI contract.

## Prompt Editor

Replace the custom `InputBox` implementation with a thin Cube adapter around pi-tui `Editor`:

- Instantiate `Editor` with a Cube theme derived from the existing color schema.
- Pass slash-command names to `CombinedAutocompleteProvider` without their leading `/`, because pi-tui adds `/` when applying a command completion.
- Preserve the current CLI event contract by translating `Editor.onSubmit` into `{ type: "user_input", payload: text }`.
- Add submitted prompts to pi-tui's editor history only after non-empty submission.
- Keep global cancellation and application shutdown handling outside the editor.
- Use `matchesKey` and `Key` for any remaining global key handling instead of raw escape-sequence comparisons.

The adapter may expose `getValue`, `setValue`, `clear`, and `handleInput` only where tests or existing callers require them. It must not reimplement text editing, cursor movement, history navigation, paste handling, or slash suggestion rendering.

## Model Catalog and Picker Flow

Typing `/model` with no argument follows this sequence:

1. The CLI asks the TUI to show a cancellable loading overlay immediately.
2. The CLI discovers local Ollama models from `<base_url>/tags` and direct Mastra `google/...` models from `cubeController.listAvailableModels()`.
3. Partial success is allowed: if one source fails and the other returns models, the picker opens with the successful source and a non-blocking warning.
4. If both sources fail, the loading overlay closes and the TUI shows a system error message.
5. The TUI opens a centered model-picker overlay containing a search `Input` and pi-tui `SelectList`.
6. The active model is initially selected when it exists in the catalog.
7. Typing filters models by model ID; Up and Down move through the filtered list; Enter selects; Escape closes without changing state.
8. Selection returns the model ID to the CLI. The CLI calls `session.model.switch({ modelId, scope: "global" })` first and persists config only after the switch succeeds.
9. On success, the overlay closes, footer/info state updates through the existing `model_changed` event, and Cube shows a concise confirmation.
10. On switch failure, the picker remains open and shows an actionable inline error so the user can choose another model; the persisted config is not changed.

`/model <model-id>` remains supported as a non-interactive compatibility path and uses the same switch-then-persist operation.

## Model Picker Composition

`ModelPicker` is a focused Cube-specific composition, not a replacement for pi-tui controls:

- `Input` owns query editing and IME cursor rendering.
- `SelectList` owns navigation, selection, cancellation, list truncation, and scroll indicators.
- The wrapper implements `Focusable` and propagates focus to its `Input` child.
- The wrapper routes printable/editing input to `Input`, mirrors the resulting value into `SelectList.setFilter()`, and routes Up, Down, Enter, and Escape to `SelectList`.
- Every returned line is width-safe through the built-in component rendering or `truncateToWidth()`.

The picker receives already-normalized model IDs. It does not perform network access, session changes, or config writes.

## Transcript Rendering

Keep `MessageList` as the stateful streaming transcript controller because it owns message identity, incremental updates, tool status, and scroll offset. Reuse pi-tui renderers inside that boundary:

- Render assistant and system content with `Markdown` so code blocks, lists, and emphasis display correctly.
- Use lightweight text rendering for user and tool status lines where Markdown semantics are unnecessary.
- Preserve the existing message update API used by CLI session subscriptions.

This transcript improvement is limited to replacing rendering mechanics. It must not redesign message storage, scrolling behavior, or session event handling in this task.

## Loading and Error Handling

- Model discovery starts with a visible `CancellableLoader` overlay.
- Escape aborts the UI wait. If an underlying API cannot consume an `AbortSignal`, late results are ignored and do not reopen the picker.
- Source-specific failures are retained as warnings so a working source can still populate the picker.
- An empty successful catalog is shown as an explicit empty-state message, not a blank overlay.
- Switch failures never call `writeConfig`.
- Overlay focus always returns to the prompt editor on close, success, cancellation, or error.

## Testing

All production changes follow red-green-refactor.

### TUI unit tests

- The prompt editor displays slash suggestions supplied by the registry and submits the completed command.
- The adapter passes command names to `CombinedAutocompleteProvider` without a leading slash.
- The model picker initially highlights the active model.
- Query input filters model IDs.
- Up and Down change selection, Enter returns the selected ID, and Escape cancels.
- Closing any overlay restores editor focus.

### CLI/model-flow tests

- `/model` without an argument opens the picker instead of formatting the catalog as a system-message list.
- A selected model switches the session before persistence.
- A failed switch does not persist.
- One failed catalog source still permits selection from the successful source.
- Two failed sources produce an actionable error.
- `/model <model-id>` remains functional.

### Verification

- Run all package tests.
- Run the recursive TypeScript build from current source.
- Perform a focused runtime smoke check against the configured Ollama endpoint.
- Start the CLI interactively and verify `/`, `/model`, filtering, Enter, Escape, focus restoration, and footer model update.

## Scope Boundaries

This change does not:

- switch Cube to an alternate-screen renderer;
- add new providers or credentials;
- cache the Mastra catalog on disk;
- redesign session persistence or memory;
- remove the non-interactive `/model <model-id>` form;
- rewrite transcript scrolling or agent event ownership.

## Success Criteria

- Prompt editing and slash autocomplete use pi-tui `Editor` and `CombinedAutocompleteProvider` rather than Cube's hand-written editor logic.
- `/model` immediately shows loading feedback and then an interactive searchable `SelectList` overlay.
- The configured Ollama model and direct available Google models are visible when their sources succeed.
- Selecting a model changes the current session and persists only after a successful switch.
- Escape safely cancels and returns focus to the prompt.
- Existing command execution, streaming messages, terminal scrollback, and footer updates continue to work.
