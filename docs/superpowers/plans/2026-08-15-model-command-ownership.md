# Model Command Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all `/model` catalog logic and tests into the model slash-command files and remove the redundant model directory.

**Architecture:** The command file owns its complete use case. The command registry continues to bind only `createModelCommandHandler`, while the CLI entrypoint provides dependencies without importing catalog helpers.

**Tech Stack:** TypeScript 5.7, Node.js test runner through tsx, pnpm workspace.

## Global Constraints

- Do not change `/model` behavior, filtering, messages, or registry metadata.
- Do not create a replacement helper directory or file.
- Preserve arrow-function exports.
- The checkout is not recognized as a Git repository, so do not claim a commit.

---

### Task 1: Consolidate model command ownership

**Files:**
- Modify: `cube-cli/src/slash-commands/model.slash-command.ts`
- Modify: `cube-cli/src/slash-commands/model.slash-command.test.ts`
- Delete: `cube-cli/src/model/model-catalog.ts`
- Delete: `cube-cli/src/model/model-catalog.test.ts`

**Interfaces:**
- Produces: unchanged `createModelCommandHandler`, `discoverModelCatalog`, `listOllamaModels`, and `runModelSlashCommand` exports from one command module.
- Consumes: unchanged `OpenModelPickerOptions`, Mastra model records, and registry handler type.

- [ ] **Step 1: Move catalog tests**

Move the five `discoverModelCatalog` cases into `model.slash-command.test.ts` and import the function from `./model.slash-command.js`.

- [ ] **Step 2: Move catalog types and implementation**

Move `AvailableModelRecord`, `ModelCatalogResult`, `errorMessage`, `throwIfAborted`, and `discoverModelCatalog` above the handler implementation in `model.slash-command.ts`. Remove the import from `../model/model-catalog.js`.

- [ ] **Step 3: Delete redundant files**

Delete `cube-cli/src/model/model-catalog.ts` and `cube-cli/src/model/model-catalog.test.ts`. Remove the empty `cube-cli/src/model` directory if no entries remain.

- [ ] **Step 4: Verify ownership and behavior**

Run:

```powershell
pnpm --filter @cube/cli test
pnpm --filter @cube/cli build
rg -n 'model/model-catalog|src/model' cube-cli/src
```

Expected: all CLI tests pass, CLI build exits 0, and the source search returns no matches.
