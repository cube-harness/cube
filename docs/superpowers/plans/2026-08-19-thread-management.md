# Thread Management, Lazy Fresh Thread Lifecycle, and History Resumption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement lazy fresh-thread startup normalization, first-prompt thread creation with automatic title extraction, interactive conversation history resumption (`/resume`), and explicit fresh conversation start (`/new`) using `CommandManager` across `@cube/agent`, `@cube/cli`, and `@cube/tui`.

**Architecture:**
- `cube-agent`: Exposes `createCubeRuntime`, initializes `controller.createSession()`, and normalizes startup to guarantee `session.thread.getId() === null`. On first prompt, it creates the thread with pre-allocated planned UUID and prompt-derived title.
- `cube-cli`: Uses `CommandManager` class for extensible command registration and execution. Injects native `session.thread` dependencies into `/resume` and `/new` command handlers.
- `cube-tui`: Implements `ThreadPickerOverlay` component (`class ThreadPickerOverlay extends Container`) using pi-tui `SelectList`. Supports `setMessages` / `clearMessages` on `MessageList`.

**Tech Stack:** TypeScript 5.7, Mastra AgentController 1.56, `@earendil-works/pi-tui`, LibSQL SQLite storage, pnpm monorepo.

---

## Global Constraints

- All test files must be located exclusively in the dedicated `tests/` directories (`cube-agent/tests/`, `cube-cli/tests/`, `cube-tui/tests/`), never inside `src/`.
- Use `class CommandManager` in `cube-cli/src/commands/command-manager.ts` to manage all commands (slash commands, skill commands, system commands).
- `cube-tui` must remain pure UI without any direct dependency on `@cube/agent` or Mastra types.
- Ensure all relative path imports across packages use the scoped package name `@cube/workspace`, `@cube/agent`, `@cube/tui`.

---

## File Structure & Plan Tasks

```
cube-agent/
  src/
    runtime.ts                          (Runtime factory with startup normalizer)
  tests/
    runtime.test.ts                     (Tests for startup normalization & lazy thread)

cube-cli/
  src/
    commands/
      command-manager.ts                (class CommandManager implementation)
      resume.command.ts                 (/resume & /threads command handler)
      new.command.ts                    (/new command handler)
    index.ts                            (Wire runtime, CommandManager, and TUI)
  tests/
    command-manager.test.ts             (Tests for CommandManager)
    resume.command.test.ts              (Tests for /resume command logic)
    new.command.test.ts                 (Tests for /new command logic)

cube-tui/
  src/
    components/
      thread-picker.ts                  (class ThreadPickerOverlay extends Container)
      message-list.ts                   (Update: setMessages / clearMessages)
    screens/
      chat.screen.ts                    (Mount thread picker overlay support)
    index.ts                            (Export openThreadPicker and UI types)
```

---

### Task 1: Implement Runtime Lazy Thread & Startup Normalization in `cube-agent`

**Files:**
- Create: `cube-agent/src/runtime.ts`
- Modify: `cube-agent/src/index.ts`
- Create: `cube-agent/tests/runtime.test.ts`

- [ ] **Step 1: Implement `createCubeRuntime` with Startup Normalization**
  - Allocate `plannedThreadId = crypto.randomUUID()`.
  - Create session via `controller.createSession({ resourceId })`.
  - Normalize startup:
    - If populated (`activeMessages.length > 0`): call `session.thread.detachFromCurrent()` and `session.thread.clearAndReleaseLock()`.
    - If empty bootstrap thread: call `session.thread.delete({ threadId })`.
  - Expose `preparePrompt()`: if `session.thread.getId() === null`, extract prompt prefix (`prompt.trim().replace(/\s+/g, ' ').slice(0, 48)`), call `session.thread.create({ id: plannedThreadId, title })`, and snapshot `SOUL.md`.
  - Expose `followUp(content)`, `session`, and `close()`.

- [ ] **Step 2: Write Unit Tests in `cube-agent/tests/runtime.test.ts`**
  - Verify startup leaves `session.thread.getId() === null`.
  - Verify open/close without prompt leaves 0 new thread records.
  - Verify first prompt creates thread with planned UUID and prompt-derived title.

---

### Task 2: Implement `ThreadPickerOverlay` and `MessageList` in `cube-tui`

**Files:**
- Create: `cube-tui/src/components/thread-picker.ts`
- Modify: `cube-tui/src/components/message-list.ts`
- Modify: `cube-tui/src/screens/chat.screen.ts`
- Modify: `cube-tui/src/index.ts`

- [ ] **Step 1: Implement `ThreadPickerOverlay` Component**
  - Create `class ThreadPickerOverlay extends Container` using `@earendil-works/pi-tui` `SelectList`.
  - Display items formatted: `[YYYY-MM-DD HH:mm] <Title> (Active?)`.
  - Listen for keybindings: `Up`/`Down` (or `j`/`k`) to navigate, `Enter` to select, `Esc`/`Ctrl+C` to dismiss.
  - Return selected `threadId` or `null` on dismiss.

- [ ] **Step 2: Add `setMessages` and `clearMessages` to `MessageList`**
  - Add `setMessages(messages: Array<{ role: string, content: string }>)` to `MessageList`.
  - Add `clearMessages()` to wipe message history.

- [ ] **Step 3: Export `openThreadPicker` and Types from `cube-tui`**
  - Export `ThreadPickerViewItem`, `OpenThreadPickerOptions`.
  - Update `TuiApp` interface to expose `openThreadPicker(options)`.

---

### Task 3: Implement `CommandManager` and Commands in `cube-cli`

**Files:**
- Modify: `cube-cli/src/commands/command-manager.ts`
- Create: `cube-cli/src/commands/resume.command.ts`
- Create: `cube-cli/src/commands/new.command.ts`
- Create: `cube-cli/tests/command-manager.test.ts`
- Create: `cube-cli/tests/resume.command.test.ts`
- Create: `cube-cli/tests/new.command.test.ts`

- [ ] **Step 1: Implement `class CommandManager`**
  - Implement `CommandManager` with `register(definition)`, `registerMany(definitions)`, `execute(name, argument)`, and `suggestions` getter.
  - Write unit tests in `cube-cli/tests/command-manager.test.ts`.

- [ ] **Step 2: Implement `/resume` (and `/threads`) Command Handler**
  - Check `isTurnActive()`.
  - Query threads via `session.thread.list()`.
  - If empty: show `"No previous threads found in this workspace."`
  - Call `app.openThreadPicker(...)`.
  - On selection: call `session.thread.switch({ threadId })`, fetch `session.thread.listMessages({ threadId })`, update TUI messages & header.
  - Write unit tests in `cube-cli/tests/resume.command.test.ts`.

- [ ] **Step 3: Implement `/new` Command Handler**
  - Check `isTurnActive()`.
  - Call `session.thread.clearAndReleaseLock()`.
  - Call `app.clearMessages()`.
  - Update InfoBox: `app.setInfo({ threadId: "new thread" })`.
  - Write unit tests in `cube-cli/tests/new.command.test.ts`.

---

### Task 4: Connect Composition Root in `cube-cli/src/index.ts`

**Files:**
- Modify: `cube-cli/src/index.ts`

- [ ] **Step 1: Wire Runtime, CommandManager, and TUI**
  - Instantiate `CommandManager` and register `/resume`, `/threads`, `/new`, `/model`, `/compact`, `/exit`.
  - Set initial TUI InfoBox to `threadId: "new thread"`.
  - Handle `command_submit` via `commandManager.execute(action.name, action.argument)`.
  - Handle `prompt_submit` with lazy thread creation via `runtime.preparePrompt()`.

---

### Task 5: End-to-End Build & Verification

- [ ] **Step 1: Run Monorepo Build**
  - Execute `pnpm build` across all packages.
- [ ] **Step 2: Run All Tests**
  - Execute `pnpm test` (running `tests/**/*.test.ts` in each package).
- [ ] **Step 3: Verify Interactive CLI Smoke Run**
  - Run `pnpm dev` and verify `/resume`, `/new`, lazy thread creation, and clean exit.
