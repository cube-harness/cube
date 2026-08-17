# Model Command Ownership Design

## Goal

Make `/model` the sole owner of its catalog discovery, provider filtering, switching, persistence, and user-facing output inside `cube-cli`.

## Boundary

`cube-cli/src/slash-commands/model.slash-command.ts` owns `AvailableModelRecord`, `ModelCatalogResult`, `discoverModelCatalog`, `listOllamaModels`, `runModelSlashCommand`, and `createModelCommandHandler`.

`cube-cli/src/slash-commands/model.slash-command.test.ts` owns all tests for those functions. The separate `cube-cli/src/model` directory is removed. Registry and CLI composition contracts remain unchanged.

## Constraints

- No behavior, model filtering, provider calls, messages, or registry metadata change.
- Do not create a replacement catalog or service file.
- Preserve arrow-function exports.
- Run focused CLI tests and build after the move.
