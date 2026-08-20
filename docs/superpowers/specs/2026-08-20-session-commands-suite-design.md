# Specification: Session Slash Commands Suite

- **Date:** 2026-08-20
- **Status:** Approved / Ready for Implementation Plan
- **Scope:** `@cube/cli` Slash Commands Extension (`/help`, `/rename`, `/delete`, `/fork`, `/usage`) & `@cube/tui` Model Picker Simplification

---

## 1. Overview & Objectives

Expand Cube CLI with a suite of 5 essential session, thread, and metrics management commands powered by Mastra's `Session` and `AgentController` APIs, while streamlining `/model` UI:
1. **`/help`**: Display a formatted reference table of all registered slash commands with usage syntax and descriptions.
2. **`/rename <title>`**: Rename the active conversation thread both in SQLite storage and on the TUI InfoBox.
3. **`/delete [threadId]`**: Delete a conversation thread via inline picker selection or explicit ID, automatically rolling over to a fresh thread if the active thread is deleted.
4. **`/fork [title]`**: Branch/clone the active thread history into a new independent session thread and immediately switch to it.
5. **`/usage`**: Display real-time token metrics, model capabilities (ctx limit, max output, tools, reasoning, vision), and context window utilization percentage with an ASCII progress bar.
6. **`/model` UI Simplification**: Remove all `[ctx]`, `[tools, reasoning, vision]` badges from the `/model` picker list, displaying strictly `modelId` and `(Active)`.

---

## 2. Architecture & Module Design

### 2.1 File Organization
All commands are isolated within `cube-cli/src/commands/`:
```text
cube-cli/src/commands/
├── model.command.ts       # Existing
├── new.command.ts         # Existing
├── resume.command.ts      # Existing
├── help.command.ts        # New
├── rename.command.ts      # New
├── delete.command.ts      # New
├── fork.command.ts        # New
└── usage.command.ts       # New
```

### 2.2 Shared Execution Rules
- **Active Turn Guard (`isTurnActive`)**: Commands mutating threads (`/rename`, `/delete`, `/fork`, `/new`, `/resume`, `/model`) must reject execution while `session.run.isRunning()` is true, notifying the user.
- **Informational Transparency**: Commands (`/help`, `/usage`) execute safely without interrupting ongoing turns.
- **TUI Suggestion Registration**: All commands are registered into `CommandManager` so suggestions appear dynamically when typing `/` in `PromptEditor`.

---

## 3. Command Specifications

### 3.1 `/help` Command (`help.command.ts`)
- **Signature**: `createHelpCommandHandler(deps: { commandManager: CommandManager; showMessage: (msg: string) => void }): CommandHandler`
- **Behavior**:
  - Iterates over `deps.commandManager.suggestions`.
  - Formats an aligned Markdown table listing command names and descriptions.
  - Outputs to chat via `deps.showMessage(...)`.

### 3.2 `/rename <title>` Command (`rename.command.ts`)
- **Signature**: `createRenameCommandHandler(deps: { session: Session; getApp: () => TuiApp | undefined; showMessage: (msg: string) => void; isTurnActive?: () => boolean }): CommandHandler`
- **Behavior**:
  - Validates turn is not active.
  - Retrieves active thread ID via `session.thread.getId()`. If null, notifies: `"No active thread to rename."`.
  - Validates argument is not empty. If empty, notifies: `"Usage: /rename <new-title>"`.
  - Executes `await session.thread.rename({ threadId: currentId, title: argument.trim() })`.
  - Updates TUI InfoBox and prints confirmation: `• Renamed thread to: "<new-title>"`.

### 3.3 `/delete [threadId]` Command (`delete.command.ts`)
- **Signature**: `createDeleteCommandHandler(deps: { session: Session; getApp: () => TuiApp | undefined; showMessage: (msg: string) => void; isTurnActive?: () => boolean }): CommandHandler`
- **Behavior**:
  - Validates turn is not active.
  - Lists available threads via `await session.thread.list()`. If none exist, notifies user.
  - If `argument` provided and valid, targets that `threadId`. Otherwise, invokes `app.openThreadPicker()` to prompt selection.
  - If user cancels selection, exits cleanly.
  - Calls `await session.thread.delete({ threadId: targetId })`.
  - **Active Thread Check**: If `targetId === session.thread.getId()`:
    - Calls `session.thread.detachFromCurrent()`.
    - Calls `app.clearMessages()`.
    - Updates InfoBox `app.setInfo({ threadId: "new thread" })`.
    - Prints: `• Deleted active thread. Started a fresh thread session.`.
  - Otherwise prints: `• Deleted thread: <targetId>`.

### 3.4 `/fork [new-title]` Command (`fork.command.ts`)
- **Signature**: `createForkCommandHandler(deps: { session: Session; getApp: () => TuiApp | undefined; showMessage: (msg: string) => void; isTurnActive?: () => boolean }): CommandHandler`
- **Behavior**:
  - Validates turn is not active.
  - Checks `currentId = session.thread.getId()`. If null, notifies: `"Cannot fork an empty session."`.
  - Calls `const cloned = await session.thread.clone({ threadId: currentId, title: argument.trim() || undefined })`.
  - Switches to cloned thread: `await session.thread.switch({ threadId: cloned.id })`.
  - Rehydrates copied messages via `session.thread.listMessages({ threadId: cloned.id })` with `extractMessageText`.
  - Calls `app.setMessages(messages)` and `app.setInfo({ threadId: cloned.id })`.
  - Prints: `• Forked thread into: <cloned.id>`.

### 3.5 `/usage` Command (`usage.command.ts`)
- **Signature**: `createUsageCommandHandler(deps: { home: Home; session: Session; showMessage: (msg: string) => void }): CommandHandler`
- **Behavior**:
  - Reads `config = await ConfigStore(deps.home).read()`.
  - Fetches model catalog via `ModelManager(deps.home).getCatalog()`.
  - Finds `currentModel` in catalog to obtain capabilities (`limit.context`, `limit.output`, `tool_call`, `reasoning`, `attachment`).
  - Reads `usage = deps.session.getTokenUsage()`.
  - Calculates context percentage: `percent = ((usage.promptTokens / limit.context) * 100)`.
  - Renders a 20-character visual progress bar: `[██░░░░░░░░░░░░░░░░░░]`.
  - Formats output card with:
    - Active model ID & capability badges (`[tools, reasoning, vision]`).
    - Context limit & Max output limit.
    - Progress bar & remaining context tokens.
    - Prompt, completion, cached, and total tokens.
    - Active thread ID.
  - Outputs to chat via `deps.showMessage(...)`.

### 3.6 `/model` Simplification (`cube-tui/src/components/model-picker.ts`)
- Removes `ctxTag` and `badgeStr` from model list labels.
- Label format is strictly: `${m.modelId}${activeTag}`.

---

## 4. Test Plan & Validation

1. **Unit Tests (`cube-cli/tests/*.test.ts`)**:
   - `help.command.test.ts`: Verify all suggestions are formatted in output table.
   - `rename.command.test.ts`: Verify validation, turn-active guard, and `session.thread.rename` call.
   - `delete.command.test.ts`: Verify deletion of non-active and active threads with clean thread detachment and message reset.
   - `fork.command.test.ts`: Verify cloning, switching, message rehydration, and InfoBox update.
   - `usage.command.test.ts`: Verify context limit resolution, progress bar rendering, capability badges, and token calculations.
2. **Integration Verification**:
   - `pnpm build` across all 4 packages.
   - Run `pnpm test` (verify 100% pass across all test suites).
