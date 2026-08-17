# Lazy Thread and Log Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reserve one UUID for the run log and create the matching persisted thread only on the first prompt.

**Architecture:** `cube-workspace` exposes `threadLog`; `cube-agent` reserves the UUID, normalizes Mastra's automatic binding to an unbound session, and passes the UUID into SOUL preparation for lazy thread creation. No production lifecycle file is added.

**Tech Stack:** TypeScript 5.7, Node.js 22, Mastra `@mastra/core` 1.56.0, pnpm workspaces.

## Constraints

- Use arrow functions in production.
- Do not add dependencies, `/new`, tool approval, or concurrent CLI support.
- Write tests before production and run them only in final verification.
- `D:\cube` is not a valid Git repository; do not create commits/worktrees.

### Task 1: Thread-owned log contract

**Files:** `cube-workspace/src/home.ts`, `cube-workspace/tests/home.test.ts`, `cube-agent/src/logger.ts`, `cube-agent/tests/logger.test.ts`.

- [x] Rename `AgentRuntimeFiles.sessionLog` to `threadLog`.
- [x] Write logs to `agent-${threadId}.json` with structured `{ threadId }`.
- [x] Add tests for path shape and JSON log identity.

### Task 2: Normalize Mastra startup binding

**Files:** `cube-agent/src/index.ts`, `cube-agent/tests/runtime-session.test.ts`.

- [x] Call `createSession({ id: plannedThreadId, ownerId, resourceId })` without the `threadId` option.
- [x] Delete the bound thread when it has no messages.
- [x] Detach and release the lock when the bound thread contains history.
- [x] End startup with no active thread and keep the populated history intact.

### Task 3: Create the planned thread on first prompt

**Files:** `cube-agent/src/session-soul.ts`, `cube-agent/tests/session-soul.test.ts`, `cube-cli/src/session-events.ts`.

- [x] Pass `plannedThreadId` into `createSessionSoul()`.
- [x] Call `session.thread.create({ id: plannedThreadId })` after SOUL validation.
- [x] Preserve incomplete-thread cleanup when the SOUL snapshot fails.
- [x] Keep `thread_created` and `thread_changed` TUI updates.

### Task 4: Final verification

- [x] Prove logger and startup tests RED under intentional mutations, then restore.
- [x] Run focused agent tests.
- [x] Run the recursive test suite.
- [x] Run TypeScript clean build and JavaScript syntax checks.
- [x] Run an isolated storage smoke proving no thread before prompt and exact UUID creation on prompt.
