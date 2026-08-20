# Specification: Session Slash Commands Suite & Config Clean-up

- **Date:** 2026-08-20
- **Status:** Approved / Ready for Implementation Plan
- **Scope:** 
  1. `@cube/cli` Slash Commands Extension (`/help`, `/rename`, `/delete`, `/fork`, `/usage`)
  2. `@cube/tui` Model Picker Simplification (only `modelId` and `(Active)`)
  3. `@cube/workspace` Config Clean-up (remove rigid `providers.ollama` from `config.yaml`, standardize on `.env`)

---

## 1. Overview & Objectives

1. **`/help`**: Display a formatted reference table of all registered slash commands with usage syntax and descriptions.
2. **`/rename <title>`**: Rename the active conversation thread both in SQLite storage and on the TUI InfoBox.
3. **`/delete [threadId]`**: Delete a conversation thread via inline picker selection or explicit ID, automatically rolling over to a fresh thread if the active thread is deleted.
4. **`/fork [title]`**: Branch/clone the active thread history into a new independent session thread and immediately switch to it.
5. **`/usage`**: Display real-time token metrics, model capabilities (ctx limit, max output, tools, reasoning, vision), and context window utilization percentage with an ASCII progress bar.
6. **`/model` UI Simplification**: Remove all `[ctx]`, `[tools, reasoning, vision]` badges from the `/model` picker list, displaying strictly `modelId` and `(Active)`.
7. **Config Schema Clean-up**: Make `providers` optional in `ConfigSchema` and remove hardcoded `ollama.base_url` from `template/config.yaml`. All provider endpoints/keys (including Ollama) are configured via `.env` with fallback defaults.

---

## 2. Architecture & Module Design

### 2.1 File Organization
```text
cube-workspace/
├── src/schemas/config.schema.ts      # Make providers optional / flexible record
└── src/template/config.yaml          # Remove static providers.ollama

cube-tui/
└── src/components/model-picker.ts    # Streamline list item label to modelId + activeTag

cube-cli/
├── src/commands/
│   ├── model.command.ts              # Existing
│   ├── new.command.ts                # Existing
│   ├── resume.command.ts             # Existing
│   ├── help.command.ts               # New
│   ├── rename.command.ts             # New
│   ├── delete.command.ts             # New
│   ├── fork.command.ts               # New
│   └── usage.command.ts              # New
└── tests/
    ├── help.command.test.ts          # New
    ├── rename.command.test.ts        # New
    ├── delete.command.test.ts        # New
    ├── fork.command.test.ts          # New
    └── usage.command.test.ts         # New
```

### 2.2 Shared Execution Rules
- **Active Turn Guard (`isTurnActive`)**: Commands mutating threads (`/rename`, `/delete`, `/fork`, `/new`, `/resume`, `/model`) must reject execution while `session.run.isRunning()` is true, notifying the user.
- **Informational Transparency**: Commands (`/help`, `/usage`) execute safely without interrupting ongoing turns.
- **TUI Suggestion Registration**: All commands are registered into `CommandManager` so suggestions appear dynamically when typing `/` in `PromptEditor`.

---

## 3. Detailed Specifications

### 3.1 Config Clean-up (`cube-workspace`)
- Update `ConfigSchema`:
  ```typescript
  providers: z.record(z.string(), z.record(z.string(), z.any())).optional().default({}),
  ```
- Remove `providers: ollama: base_url: ...` from `cube-workspace/src/template/config.yaml`.
- In `ModelManager` and `main.agent.ts`, resolve Ollama base URL via `process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || "http://127.0.0.1:11434/api"`.

### 3.2 `/model` Simplification (`cube-tui`)
- In `ModelPickerComponent`, format model item labels as `${m.modelId}${activeTag}`.

### 3.3 `/help` Command (`cube-cli`)
- Iterates over `commandManager.suggestions` and formats a Markdown table with command names and descriptions.

### 3.4 `/rename <title>` Command (`cube-cli`)
- Validates active thread and non-empty title argument.
- Executes `await session.thread.rename({ threadId, title })`.
- Prints confirmation to chat and updates InfoBox.

### 3.5 `/delete [threadId]` Command (`cube-cli`)
- If argument provided, deletes targeted thread. Otherwise, opens inline `ThreadPicker`.
- If deleting active thread: detaches thread, clears messages, resets InfoBox, and notifies user.

### 3.6 `/fork [new-title]` Command (`cube-cli`)
- Clones active thread via `await session.thread.clone({ threadId, title })`.
- Switches to cloned thread, rehydrates copied messages via `listMessages`, updates InfoBox, and notifies user.

### 3.7 `/usage` Command (`cube-cli`)
- Reads active model's metadata (`limit.context`, `limit.output`, capability flags).
- Reads `session.getTokenUsage()`.
- Calculates percentage and renders ASCII progress bar `[██░░░░░░░░░░░░░░░░░░]`.
- Displays detailed card with token breakdown, context remaining, and active thread.

---

## 4. Test Plan & Validation

- Unit tests for all 5 new commands in `cube-cli/tests/`.
- Unit tests for updated `ConfigSchema` in `cube-workspace/tests/`.
- Unit tests for streamlined `ModelPickerComponent` in `cube-tui/tests/`.
- Full monorepo build `pnpm build` and `pnpm test` (100% pass).
