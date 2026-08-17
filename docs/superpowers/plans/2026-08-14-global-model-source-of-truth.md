# Global Model Source of Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure `~/.cube/config.yaml` always determines the active Cube model after Mastra hydrates an existing thread.

**Architecture:** Add one small startup reconciliation function at the Cube-to-Mastra controller boundary. The function overwrites any hydrated thread model with the configured global model, while `/model` keeps using global scope and persisting the same value to `config.yaml`.

**Tech Stack:** TypeScript 5.7, Node.js test runner, Mastra `AgentController` 1.56.0, pnpm workspace.

## Global Constraints

- `config.yaml.model` is the only durable source of truth for model selection.
- Thread metadata must not determine the active model after startup.
- Do not delete or migrate existing threads, messages, or metadata.
- Do not change `/model` to thread scope.
- Do not add provider-specific model logic or additional provider API calls.
- `D:\cube` is not a Git worktree, so commit steps are intentionally omitted.

---

### Task 1: Reconcile the hydrated session with the configured global model

**Files:**
- Create: `cube-agent/src/agents/controller.test.ts`
- Modify: `cube-agent/src/agents/controller.ts:1-25`
- Modify: `cube-agent/src/index.ts:70-76`

**Interfaces:**
- Consumes: a session-like value exposing `model.get(): string` and `model.set({ modelId: string }): void`.
- Produces: `applyConfiguredModel<T extends ConfiguredModelSession>(session: T, modelId: string): T`.
- Startup uses the returned session as the exported `session` value.

- [ ] **Step 1: Write the failing regression test**

Create `cube-agent/src/agents/controller.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { applyConfiguredModel } from "./controller.js";

test("configured global model overrides the model hydrated from thread metadata", () => {
  let activeModel = "anthropic/claude-opus-4-6";
  const session = {
    model: {
      get: () => activeModel,
      set: ({ modelId }: { modelId: string }) => {
        activeModel = modelId;
      },
    },
  };

  const result = applyConfiguredModel(session, "google/gemini-3.5-flash");

  assert.equal(result, session);
  assert.equal(session.model.get(), "google/gemini-3.5-flash");
});
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run:

```powershell
pnpm --filter @cube/agent exec tsx --test --test-isolation=none src/agents/controller.test.ts
```

Expected: FAIL because `applyConfiguredModel` is not exported from `controller.ts`.

- [ ] **Step 3: Add the minimal reconciliation function**

Add to `cube-agent/src/agents/controller.ts`:

```ts
export interface ConfiguredModelSession {
  model: {
    get(): string;
    set(input: { modelId: string }): void;
  };
}

export const applyConfiguredModel = <T extends ConfiguredModelSession>(
  session: T,
  modelId: string,
): T => {
  if (session.model.get() !== modelId) {
    session.model.set({ modelId });
  }
  return session;
};
```

This function uses the in-memory setter deliberately: it makes the global config authoritative without writing model state back to the thread.

- [ ] **Step 4: Apply reconciliation after Mastra session hydration**

Update the import in `cube-agent/src/index.ts`:

```ts
import { applyConfiguredModel, createController } from "./agents/controller.js";
```

Replace the session initialization with:

```ts
export const session = applyConfiguredModel(
  await cubeController.createSession({
    id: sessionId,
    ownerId: resourceId,
    resourceId,
  }),
  config.model,
);
```

Do not call `session.model.switch()` here: startup reconciliation must not persist thread-owned model metadata or report a user-initiated switch.

- [ ] **Step 5: Run the focused agent tests and verify green**

Run:

```powershell
pnpm --filter @cube/agent test
```

Expected: all `@cube/agent` tests PASS, including the stale-Anthropic regression.

- [ ] **Step 6: Build the affected packages from source**

Run:

```powershell
& '.\node_modules\.bin\tsc.cmd' --build 'cube-agent\tsconfig.json' 'cube-cli\tsconfig.json' --force --pretty false
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 7: Run the complete regression suite**

Run:

```powershell
pnpm --recursive --if-present test
```

Expected: every workspace test passes with zero failures.

- [ ] **Step 8: Reproduce the original startup boundary**

Run a read-only smoke script that loads `.env`, imports the built agent, prints only the configured and active model IDs, and closes storage:

```powershell
node --input-type=module -e 'const { loadCubeEnv } = await import("./cube-cli/dist/env.js"); loadCubeEnv(); const agent = await import("./cube-agent/dist/index.js"); console.log(JSON.stringify({ configModel: agent.config.model, sessionModel: agent.session.model.get() })); await agent.closeCube();'
```

Expected: `configModel` and `sessionModel` are identical even though the existing database contains stale thread model metadata.

- [ ] **Step 9: Inspect the final scope**

Confirm only these production behaviors changed:

```text
Mastra thread hydration -> apply config.model -> export active session
```

Confirm `/model` remains global, no database records are deleted, no provider-specific file is introduced, and no provider generation request is added.
