# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Structure

pnpm monorepo managed with Turborepo (`packages: ['cube-*']`, Node `>=22.13.0`). Dependency flow: `cube-tui` -> `cube-runtime` -> `cube-agent` -> `cube-workspace`.

- `cube-workspace` (`@cube/workspace`): Configuration (`config.yaml`), credentials (`auth.json`), Zod schemas, home directory (`~/.cube` via `HomeManager`), root detection, and `AGENTS.md` context file discovery (`WorkspaceManager`).
- `cube-agent` (`@cube/agent`): Mastra framework integration. Defines core `Agent`, LibSQL memory/storage, gateway adapters (API key, OAuth, local Ollama/LM Studio), prompt processor, and `AgentController`.
- `cube-runtime` (`@cube/runtime`): Orchestration layer. Houses `CubeRuntime` lifecycle, session subscriptions, OAuth authentication flows (Anthropic, Google, Grok, OpenAI), slash commands, and domain services (`gateway`, `model`, `thread`, `prompt`, `preference`).
- `cube-tui` (`@cube/tui`): Terminal UI (`@earendil-works/pi-tui`) and CLI entrypoint (`bin: { "cube": "./dist/main.js" }`), providing screens (`ChatScreen`, `OnBoardScreen`), themes, and keybindings.

## Build, Test & Dev Commands

- Build all packages: `pnpm build` (runs `tsc --build` across all packages via Turbo).
- Build single package: `pnpm --filter @cube/<pkg> build`
- Typecheck: `pnpm typecheck` (runs `tsc --build` using root project references).
- Dev mode: `pnpm dev` (runs CLI dev mode via `tsx`).
- Mastra Studio: `pnpm studio` (runs `mastra dev --dir src/mastra` in `cube-agent`).
- Run package tests: `pnpm --filter @cube/<pkg> test` (runs `tsx --test --test-isolation=none tests/**/*.test.ts`).
- Run single test file: `pnpm --filter @cube/<pkg> exec tsx --test tests/<path>.test.ts`
- Run test by pattern: `pnpm --filter @cube/<pkg> exec tsx --test --test-name-pattern="<pattern>" tests/<path>.test.ts`

## Code Style & Naming Conventions

- ESM / NodeNext: Relative imports **must** include the `.js` extension (e.g. `import { foo } from "./bar.js"`).
- Node stdlib: Always use the `node:` protocol prefix (e.g. `node:path`, `node:test`, `node:assert/strict`).
- Prettier: Double quotes, 2 spaces indent, semicolons, trailing commas (`"all"`), print width 100.
- File naming: Kebab-case with dot-descriptors (`<name>.<type>.ts`, e.g. `auth.store.ts`, `gateway.service.ts`, `chat.screen.ts`).
- Validation: Zod schemas for all configs and credentials; atomic writes (`atomic-write.ts`) for disk persistence.

## Architecture Overview

- **Mastra & AgentController**: Core agent execution delegates to Mastra (`@mastra/core`). `createCubeController` binds Mastra's `AgentController` to workspace filesystem tools, SQLite memory, and model gateways. `Session` coordinates turns, streaming, and tool approvals.
- **Runtime Lifecycle**: `CubeRuntime` isolates the agent from the UI, providing reactive event subscriptions (`subscribe`), display state management, and command coordination.
- **Gateway & Authentication**: Models route via gateways (`api_key/*`, `oauth/*`, `local/*`). `cube-runtime/src/auth/` implements PKCE OAuth flows; credentials persist in `auth.json`.
- **Workspace Context**: `WorkspaceManager` walks up directories to locate project roots and injects `AGENTS.md` files (including `.agents/`, `.cube/`, `.claude/`, `.codex/`) into `<project_context>` system prompt blocks.

## Commit Guidelines

Follow Conventional Commits: `<type>(<scope>): <description>`. Scopes correspond to packages or subsystems (e.g. `feat(cube-runtime): ...`, `fix(cube-tui): ...`, `refactor(cube-agent): ...`, `docs: ...`, `chore: ...`).
