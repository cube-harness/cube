# Capability-Aware Model Selection and Configuration

Date: 2026-08-16
Status: Approved design; implementation not started

## Goal

Make `/model` select an active model together with only the runtime settings that the exact model supports. Persist the active selection globally in `config.yaml`, restore it on the next Cube process, and never send unsupported provider options.

The initial configurable setting is normalized reasoning effort. The schema is nested so later phases can add other model settings without adding unrelated `model_*` keys at the root.

## Scope

This phase covers:

- authenticated cloud model discovery and local Ollama discovery;
- per-model reasoning-effort capability discovery;
- an inline model-then-config selection flow in the TUI;
- global persistence of the active model and its config;
- runtime mapping for direct OpenAI, direct Google, and OpenRouter;
- non-crashing warnings and rollback when configuration cannot be applied;
- package-level tests stored outside `src`.

This phase does not add reasoning-budget controls, per-model saved profiles, per-thread model config, direct catalog calls to every cloud provider, automatic inference retries, or config for internal memory models.

## Persisted Configuration

`config.yaml` stores one active global selection:

```yaml
model: openai/gpt-5.1
model_config:
  reasoning_effort: high
```

For a model without a supported configurable option:

```yaml
model: ollama/qwen2.5:7b
model_config: {}
```

`model_config` defaults to `{}` and is a strict object. In this phase its only optional field is:

```ts
type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

interface ModelConfig {
  reasoning_effort?: ReasoningEffort;
}
```

The static schema validates the shape and known effort vocabulary. Semantic validation then checks whether the selected model supports that field and value.

Cube does not store a map of config by model. Selecting another model replaces both `model` and `model_config`. Returning to an earlier model requires choosing its config again. `fallback_model` remains a model ID only; an activated fallback uses its provider defaults and does not inherit the primary model's config.

## Model Catalog

### Cloud source

Cube Agent owns the cloud catalog and fetches `https://models.dev/api.json`. The response supplies provider IDs, API-key environment variables, model IDs, base reasoning capability, and `reasoning_options`.

The raw catalog is used instead of `AgentController.listAvailableModels()` because the installed Mastra controller return type exposes authentication and identity fields but drops `reasoning_options`.

Cube performs one cloud catalog request, not separate model-list calls to OpenAI, Google, Anthropic, and OpenRouter. The successfully parsed cloud catalog is cached until the Cube process exits. Concurrent callers share the same in-flight request.

A cloud provider is eligible only when one of its declared API-key environment variables contains a non-empty value. Eligible model IDs retain their full route, so direct and gateway models remain distinguishable:

```text
openai/gpt-5.1
openrouter/openai/gpt-5.1
```

### Ollama source

Ollama remains a separate local source. Cube requests `<providers.ollama.base_url>/tags` whenever `/model` opens so newly installed or removed local models are reflected without restarting Cube.

Ollama tags do not provide a reliable normalized effort capability in this phase. Ollama models therefore receive `model_config: {}` even when a particular underlying model may support other thinking controls. Local reasoning controls can be added in a later phase using an authoritative local capability source.

### Capability normalization

The catalog normalizes each model into a UI-safe contract:

```ts
interface ModelCatalogEntry {
  id: string;
  provider: string;
  config: {
    reasoningEffort?: {
      values: ReasoningEffort[];
    };
  };
}
```

Only `reasoning_options` entries with `type: "effort"` populate `reasoningEffort`. The allowed values come from the exact model entry and are never inferred from provider name alone.

The following cases expose no effort picker and produce `model_config: {}`:

- `reasoning` is false;
- `reasoning_options` is absent;
- the only available controls are `toggle` or `budget_tokens`;
- the model is a dynamic router without fixed effort options;
- Cube has no runtime mapper for the route's provider;
- capability metadata is missing or cannot be trusted.

For example, Gemini 3 effort models are configurable in this phase, while Gemini 2.5 budget-only models use their provider default. A later phase may add `reasoning_budget_tokens` without changing the root config layout.

Cloud and Ollama discovery run in parallel. Results are deduplicated by full model ID and sorted for display. If one source fails, Cube shows the other source with a warning. If both sources fail or both return no usable models, `/model` reports an error and leaves the current selection untouched.

## Package Ownership

| Package | Ownership |
| --- | --- |
| `cube-workspace` | Defines the structural config schema and reads/writes `model` plus `model_config`. It does not call model APIs or interpret provider options. |
| `cube-agent` | Fetches and normalizes catalog capabilities, performs semantic validation, maps normalized config to provider options, and applies the active runtime selection. |
| `cube-cli` | Owns the `/model` command handler and coordinates loading, selection, validation, persistence, apply, rollback, and user-facing messages. |
| `cube-tui` | Renders inline selectors from plain view data and returns a selection. It contains no provider, Mastra, environment, or persistence logic. |

The active `ModelSelection` contract is:

```ts
interface ModelSelection {
  modelId: string;
  config: ModelConfig;
}
```

Cube Agent keeps the active config in process-global runtime state initialized from `config.yaml`; it is not persisted in Mastra thread settings. The existing session model ID remains synchronized for controller events and display, but thread state is not the source of truth for model config.

The selected config applies only to the primary interactive agent model entry. It does not leak into fallback entries, observational memory, reflection, title generation, or other internal model calls.

## TUI Interaction

`/model` is an inline two-step flow rendered in the existing control area below the prompt input. It is not a centered popup.

1. A cancellable loader obtains the catalog.
2. `SelectList` displays searchable model IDs and marks the current model.
3. After a model is chosen, Cube examines that entry's normalized config capability.
4. If effort values exist, a second `SelectList` requires the user to choose one of those exact values.
5. If no configurable option exists, the candidate config is `{}` and the flow proceeds immediately.
6. Only a complete `ModelSelection` is returned to Cube CLI.

An explicit command such as `/model openai/gpt-5.1` skips the model list but does not skip the config step. It validates that the model is available and authenticated, then requires an effort selection when supported.

Escape from the config step returns to the model list when the command began with the list. Escape from the model list cancels the command. For an explicit model argument, Escape from the config step cancels the command. Cancellation never changes runtime or persisted state.

The success message includes the selected model and, when present, the chosen effort.

## Runtime Mapping

Cube Agent maps the normalized field only after capability validation:

```text
Direct OpenAI
model_config.reasoning_effort
→ providerOptions.openai.reasoningEffort

Direct Google effort models
model_config.reasoning_effort
→ providerOptions.google.thinkingConfig.thinkingLevel

OpenRouter
model_config.reasoning_effort
→ providerOptions.openrouter.reasoning.effort
```

No empty provider-options object is sent for `model_config: {}`. Budget-only Google models receive no effort mapping. Unsupported providers receive no mapping even if a future catalog entry advertises a field Cube does not yet implement.

The dynamic primary model entry returned by Cube Agent contains the resolved model, retry limit, and mapped provider options. The fallback entry remains independent and uses provider defaults.

## Startup Behavior

At startup:

1. Cube Workspace structurally reads `config.yaml`.
2. Cube Agent resolves semantic capability for the configured model when catalog metadata is available.
3. A supported config is applied to the active runtime selection.
4. An unsupported field or value is omitted from the runtime selection and reported as a warning.
5. Cube continues with the configured model and provider defaults.

Startup semantic normalization does not rewrite the user's file. The warning remains visible so the user can correct the file or run `/model` to replace it.

## Commit and Rollback

No state changes occur while the user is browsing or while a selection is incomplete.

For a completed candidate, Cube CLI coordinates:

1. capture the previous persisted and runtime selection;
2. ask Cube Agent to validate and prepare the candidate without mutation;
3. atomically write the candidate to `config.yaml` through Cube Workspace;
4. apply the prepared selection to Cube Agent runtime;
5. Cube Agent treats apply as commit-or-restore: if synchronizing the runtime config and session model ID fails, it restores both parts of the previous runtime selection before returning the error;
6. if runtime apply fails, Cube CLI restores the previous persisted selection;
7. report success only after persistence and runtime apply both succeed.

If config persistence fails, runtime is not changed. If persisted rollback fails, the restored runtime remains on the previous selection while Cube reports both the original apply failure and the rollback failure, remains alive, and does not claim that runtime and disk are synchronized.

Provider inference is not used to validate a selection. The first real provider request still occurs when the user sends a prompt, so changing a model never consumes inference quota.

## Error Handling

- Missing cloud authentication excludes the provider from the picker. An explicit unauthenticated model ID produces a user-facing error.
- Invalid structural config returns the existing Workspace config error/fallback behavior and never throws through the TUI event loop.
- A structurally valid but semantically unsupported config produces a warning and is omitted at runtime.
- Catalog cancellation produces no message and no state change.
- A partial catalog failure shows available models plus source warnings.
- A provider error during a prompt is rendered to the user while Cube remains usable.
- Cube does not silently retry an inference request without reasoning config, because that could consume quota twice or duplicate tool effects.
- User-owned config is not automatically rewritten during startup recovery.

## Tests and Verification

Tests live in package-level `tests` directories, never beside production files under `src`:

```text
cube-workspace/tests/
cube-agent/tests/
cube-cli/tests/
cube-tui/tests/
```

Any model-command tests touched by this phase are moved out of `src` as part of the scoped cleanup.

Coverage includes:

- Workspace schema defaults, `{}`, supported effort vocabulary, read/write, and atomic persistence failure;
- catalog parsing, authentication filtering, full-ID preservation, deduplication, caching, partial failure, cancellation, effort normalization, and budget-only exclusion;
- Agent semantic validation and provider-option mapping for OpenAI, Google, and OpenRouter;
- isolation of primary config from fallback and internal model calls;
- CLI list flow, explicit-ID flow, required config selection, cancellation, persistence failure, apply failure, and rollback;
- TUI model-to-config transition, no-config completion, keyboard navigation, back/cancel behavior, inline rendering, and errors;
- restart restoration and warning behavior for unsupported user-edited config.

Unit and integration tests use deterministic fixtures and do not call live catalog or inference APIs. Test, build, typecheck, and syntax verification run only in the final verification task, not between implementation tasks. A live provider smoke test requires explicit user approval because it may consume quota or incur cost.

## Acceptance Criteria

- `/model` lists Ollama plus only authenticated cloud providers.
- Direct OpenAI and OpenRouter-routed OpenAI model IDs are visibly distinct.
- Every effort-capable selection requires an effort choice, including explicit `/model <id>`.
- Models without effort capability never receive `reasoning_effort`.
- Switching models replaces both global `model` and `model_config`.
- Restart restores the active selection from `config.yaml`.
- Unsupported user-edited config warns, is omitted, and does not crash Cube.
- Cancellation and failures do not leave runtime and config knowingly inconsistent.
- No model switch performs an inference request or hidden inference retry.
- TUI controls remain inline below the prompt input.
- Tests are outside `src` and verification is deferred to the final task.

## References

- Mastra installed API: per-model fallback entries accept `providerOptions`; AgentController catalog entries do not expose reasoning options.
- Models.dev catalog: https://models.dev/api.json
- Models.dev repository and schema: https://github.com/anomalyco/models.dev
- Google thinking controls: https://ai.google.dev/gemini-api/docs/generate-content/thinking
- OpenRouter reasoning controls: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
