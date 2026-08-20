# Thread Management, Lazy Fresh Thread Lifecycle, and History Switching Design

Date: 2026-08-19
Status: Approved

## 1. Overview & Goals

This specification defines the Thread Management and conversation lifecycle for Cube CLI based on native **Mastra 1.56 (`Session.thread`)** capabilities and `@earendil-works/pi-tui`.

### Core Goals:
1. **Lazy Fresh Thread on Startup**: Opening and closing Cube without submitting a prompt creates zero records in the database.
2. **Startup Normalization (Anti-Stick)**: Reopening Cube after `/exit` or terminating a session always starts with `session.thread.getId() === null` (`new thread`), never binding to old historical threads automatically.
3. **First-Prompt Materialization**: A thread record is created in LibSQL via `session.thread.create({ id: plannedThreadId, title })` only upon the user's first prompt submission.
4. **Prompt-Derived Title**: The first ~48 characters of the user prompt are truncated and used as `title` (0ms latency, zero token cost).
5. **Interactive Thread Resumption (`/resume`, `/threads`)**: An interactive terminal overlay (`ThreadPickerOverlay`) powered by `@earendil-works/pi-tui` `SelectList` allows switching between past threads in the current workspace.
6. **Explicit Fresh Thread (`/new`)**: Starts a clean conversation thread immediately without restarting the CLI process.
7. **Direct Mastra Session Usage**: `cube-cli` commands consume `runtime.session.thread` directly without creating artificial wrapper classes.
8. **Extensible Command Management**: `CommandManager` class manages command registrations, execution, and suggestions (supporting slash commands, system commands, and skills).

---

## 2. Memory & Performance Rationale

### 2.1 V8 Heap Allocation & Prototype Optimization
- **Classes with Methods (`class Home`, `class CommandManager`, `class ThreadPickerOverlay`)**:
  In V8, methods reside on the constructor's `prototype`. All instances share a single memory copy of the methods with optimized Hidden Classes and Inline Caching.
- **Stateless Command Actions (`createResumeCommandHandler`, `createNewCommandHandler`)**:
  Defined at module scope (static function references), instantiated once at application startup with zero runtime GC churn.

---

## 3. Package Architecture & Dependencies

```
+-------------------------------------------------------------------------------+
|                                   @cube/cli                                   |
|                         (Executable Composition Root)                         |
|  - CommandManager class (registers & executes /resume, /new, /model, etc.)    |
|  - Consumes runtime.session.thread directly (Mastra SessionThread)            |
|  - Coordinates switching, message reload, and TUI rehydration                |
+---------------------------------------+---------------------------------------+
                                        |
            +---------------------------+---------------------------+
            |                                                       |
            v                                                       v
+-----------------------+                               +-----------------------+
|      @cube/agent      |                               |       @cube/tui       |
|  (Headless Runtime)   |                               |       (Pure UI)       |
| - Exposes `session`   |                               | - ThreadPickerOverlay |
|   (Mastra Session)    |                               |   (pi-tui SelectList) |
| - Startup normalizer  |                               | - MessageList         |
| - LibSQL storage      |                               |   setMessages()       |
| - preparePrompt() /   |                               | - InfoBox setInfo()   |
|   followUp()          |                               |                       |
+-----------------------+                               +-----------------------+
```

---

## 4. `CommandManager` Specification (`cube-cli/src/commands/command-manager.ts`)

```ts
import type { SlashCommandSuggestion } from "@cube/tui";

export type CommandHandler = (argument: string) => Promise<void>;

export interface CommandDefinition {
  name: string;
  description: string;
  handler: CommandHandler;
}

export class CommandManager {
  private readonly commands = new Map<string, CommandDefinition>();

  constructor(private readonly showMessage: (message: string) => void) {}

  register(definition: CommandDefinition): this {
    this.commands.set(definition.name, definition);
    return this;
  }

  registerMany(definitions: CommandDefinition[]): this {
    for (const def of definitions) {
      this.register(def);
    }
    return this;
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  async execute(name: string, argument: string = ""): Promise<void> {
    const command = this.commands.get(name);
    if (!command) {
      this.showMessage(`Unknown command: ${name}`);
      return;
    }
    await command.handler(argument);
  }

  get suggestions(): SlashCommandSuggestion[] {
    return Array.from(this.commands.values()).map(({ name, description }) => ({
      name: (name.startsWith("/") ? name : `/${name}`) as `/${string}`,
      description,
    }));
  }
}
```

---

## 5. CLI Commands (`cube-cli/src/commands/`)

### 5.1 `/resume` (and `/threads`) Command (`resume.command.ts`)
```ts
import type { AgentControllerThread, MastraDBMessage } from "@mastra/core";
import type { OpenThreadPickerOptions } from "@cube/tui";
import type { CommandHandler } from "./command-manager.js";

export interface ResumeCommandDependencies {
  listThreads: () => Promise<AgentControllerThread[]>;
  getActiveThreadId: () => string | null;
  switchThread: (threadId: string) => Promise<void>;
  listMessages: (threadId: string) => Promise<MastraDBMessage[]>;
  isTurnActive: () => boolean;
  openThreadPicker: (options: OpenThreadPickerOptions) => Promise<string | null>;
  setMessages: (messages: MastraDBMessage[]) => void;
  setInfo: (info: { threadId: string }) => void;
  showMessage: (message: string) => void;
}

export const createResumeCommandHandler = (
  deps: ResumeCommandDependencies,
): CommandHandler => async () => {
  if (deps.isTurnActive()) {
    deps.showMessage("Cannot switch threads while an agent turn is active.");
    return;
  }

  const threads = await deps.listThreads();
  if (threads.length === 0) {
    deps.showMessage("No previous threads found in this workspace.");
    return;
  }

  const activeId = deps.getActiveThreadId();
  const selectedThreadId = await deps.openThreadPicker({
    threads: threads.map((t) => ({
      id: t.id,
      title: t.title || "Untitled Thread",
      updatedAt: t.updatedAt ? new Date(t.updatedAt).toISOString() : new Date().toISOString(),
      isActive: t.id === activeId,
    })),
  });

  if (!selectedThreadId || selectedThreadId === activeId) return;

  await deps.switchThread(selectedThreadId);
  const messages = await deps.listMessages(selectedThreadId);
  deps.setMessages(messages);
  deps.setInfo({ threadId: selectedThreadId });
  deps.showMessage(`Switched to thread: ${selectedThreadId}`);
};
```

### 5.2 `/new` Command (`new.command.ts`)
```ts
import type { CommandHandler } from "./command-manager.js";

export interface NewCommandDependencies {
  isTurnActive: () => boolean;
  detachCurrentThread: () => Promise<void>;
  clearMessages: () => void;
  setInfo: (info: { threadId: string }) => void;
  showMessage: (message: string) => void;
}

export const createNewCommandHandler = (
  deps: NewCommandDependencies,
): CommandHandler => async () => {
  if (deps.isTurnActive()) {
    deps.showMessage("Cannot start new thread while an agent turn is active.");
    return;
  }

  await deps.detachCurrentThread();
  deps.clearMessages();
  deps.setInfo({ threadId: "new thread" });
  deps.showMessage("Started a new conversation thread.");
};
```

---

## 6. TUI Component & Types (`cube-tui`)

### 6.1 UI Data Types
`cube-tui` remains pure UI and only knows structural view models:

```ts
export interface ThreadPickerViewItem {
  id: string;
  title: string;
  updatedAt: string;
  isActive: boolean;
}

export interface OpenThreadPickerOptions {
  threads: ThreadPickerViewItem[];
}
```

### 6.2 `ThreadPickerOverlay` Component (`cube-tui/src/components/thread-picker.ts`)
- Class extending `@earendil-works/pi-tui` `Container`.
- Renders `SelectList` in alt-screen with formatting: `[YYYY-MM-DD HH:mm] <Title> (Active?)`.
- Keyboard controls:
  - `Up` / `Down` / `k` / `j`: Navigate items.
  - `Enter`: Resolves promise with selected `threadId`.
  - `Escape` / `Ctrl+C`: Resolves promise with `null` (cancel).

---

## 7. Runtime Lifecycle Workflows (`cube-agent`)

### 7.1 Startup Normalization
Inside `createCubeRuntime`:
1. Allocate `plannedThreadId = crypto.randomUUID()`.
2. Initialize run log to `logs/agent-${plannedThreadId}.json`.
3. Call `controller.createSession({ resourceId })`.
4. Inspect the thread Mastra auto-bound:
   - If populated (`activeMessages.length > 0`): call `session.thread.detachFromCurrent()` and `session.thread.clearAndReleaseLock()`.
   - If empty bootstrap: call `session.thread.delete({ threadId })`.
5. Session ends startup with `session.thread.getId() === null`.
6. CLI sets TUI InfoBox: `threadId: "new thread"`.

### 7.2 First-Prompt Creation
When user sends first prompt:
1. CLI calls `runtime.preparePrompt()`.
2. If `session.thread.getId() === null`:
   - Truncate prompt: `const title = prompt.trim().replace(/\s+/g, " ").slice(0, 48)`.
   - Call `session.thread.create({ id: plannedThreadId, title })`.
   - Snapshot `SOUL.md` into thread metadata.
3. Update TUI InfoBox with real `plannedThreadId`.
4. Proceed with `runtime.followUp(prompt)`.

---

## 8. Verification & Test Suite Structure

All test files are strictly placed in dedicated `tests/` directories:

1. **`cube-agent/tests/runtime.test.ts`**:
   - Verify `normalizeStartup` detaches populated threads and deletes empty bootstrap threads.
   - Verify first prompt creates thread with planned UUID and prompt-derived title.
   - Verify open/close without prompt leaves 0 new records in SQLite.
2. **`cube-cli/tests/resume.command.test.ts`**:
   - Verify `/resume` opens picker, switches thread, and rehydrates message list.
3. **`cube-cli/tests/new.command.test.ts`**:
   - Verify `/new` detaches thread and resets UI.
4. **`cube-cli/tests/command-manager.test.ts`**:
   - Verify `CommandManager` registration, execution, and suggestions.
