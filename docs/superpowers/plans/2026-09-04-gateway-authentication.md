# Gateway Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add gateway-based authentication and model selection for API-key, OpenAI subscription, Ollama, and LM Studio runtimes while preserving Cube's canonical model catalog and existing conversation flow.

**Architecture:** `cube-workspace` owns versioned non-secret configuration and the secret auth store; `cube-agent` owns six transport-specific Mastra gateways and canonical-to-router model resolution; `cube-runtime` owns preflight, gateway readiness, transactional switching, and slash-command results; `cube-tui` owns onboarding and interactive selection. `config.yaml` remains the source of truth for the active gateway/model, `auth.json` stores credentials, and `model-catalog.json` remains a derived capability cache.

**Tech Stack:** TypeScript 5.7, Node.js 22, Zod 4, YAML 2.7, Mastra `@mastra/core` 1.63.2 custom model gateways, AI SDK 6, `ollama-ai-provider-v2` 3.6, `@earendil-works/pi-tui` 0.84.2, Node test runner through `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-04-gateway-authentication-design.md`

## Global Constraints

- Do not add release, packaging, proxy-server, Anthropic subscription, key rotation, quota tracking, or automatic fallback work.
- Never print, snapshot, log, or commit API keys, access tokens, refresh tokens, authorization codes, callback queries, or token-exchange bodies.
- Persist only canonical model IDs such as `google/gemini-*`; Mastra router prefixes are internal runtime values.
- Keep the slash-command registry as the sole command metadata owner.
- Do not call Mastra `GatewayManager.listProviders()` from user-facing discovery because its failure path may write warnings to the terminal; query Cube gateway adapters behind Cube error handling.
- Preserve unrelated working-tree changes. Before every commit, inspect `git status --short` and stage only the files named by that task.
- Use Windows-safe test teardown: `rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })`.
- Every expected provider/auth/network/catalog failure must become a `RuntimeNotice` rendered as a system message while the app remains idle.

## Target File Structure

```text
cube-workspace/
  src/gateway.ts                         # stable gateway IDs and persisted config types
  src/schemas/auth.schema.ts             # auth.json validation
  src/schemas/config.schema.ts           # v1 input + v2 output schemas
  src/config-migration.ts                # v1 -> v2 migration and gateway inference
  src/store/auth.store.ts                # merge-safe credential operations
  src/bootstrap.ts                       # non-secret seeding only; no credential env loader
  src/model-manager.ts                   # canonical capability cache only
  src/template/config.yaml               # version 2, no fallback
  src/template/auth.json                 # empty valid version 1 auth object
  tests/config-migration.test.ts
  tests/auth.store.test.ts

cube-agent/
  src/gateways/types.ts                  # adapter contract and internal route mapping
  src/gateways/models-dev.delegate.ts    # installed ModelsDevGateway composition
  src/gateways/api-key.gateway.ts        # Google/OpenRouter/OpenAI API-key routes
  src/gateways/ollama.gateway.ts
  src/gateways/lmstudio.gateway.ts
  src/gateways/openai-subscription.gateway.ts
  src/gateways/index.ts                  # factory/exports
  src/agents/main.agent.ts               # no Ollama special-case
  src/bootstrap.ts                       # register adapters in Mastra/controller
  src/logger.ts                          # complete secret redaction
  tests/gateways/api-key.gateway.test.ts
  tests/gateways/routing.test.ts
  tests/gateways/catalog.test.ts
  tests/gateways/ollama.gateway.test.ts
  tests/gateways/lmstudio.gateway.test.ts
  tests/gateways/openai-subscription.gateway.test.ts

cube-runtime/
  src/auth/openai.ts                     # PKCE, callback, token exchange/refresh
  src/auth/auth-manager.ts               # credential replacement boundary
  src/services/gateway.service.ts        # readiness, discovery, transaction/rollback
  src/services/model.service.ts          # active-gateway filtering only
  src/preflight.ts                       # bootstrap without agent/session construction
  src/bootstrap.ts                       # construct runnable runtime after readiness
  src/slash-commands.ts                  # /gateway and gateway-scoped /model
  src/types.ts                           # serializable setup/picker result types
  tests/auth/openai.test.ts
  tests/services/gateway.service.test.ts
  tests/preflight.test.ts

cube-tui/
  src/components/gateway-picker.ts       # group/provider/endpoint state machine
  src/components/secret-input.ts         # masked key entry
  src/components/oauth-login.ts          # cancellable loader + OSC 8 URL
  src/screens/chat.screen.ts             # shared overlay entry points
  src/app.ts                             # prompt-result orchestration
  src/main.ts                            # renderer-first preflight/onboarding/startup
  tests/gateway-picker.test.ts
  tests/secret-input.test.ts
  tests/oauth-login.test.ts
  tests/onboarding.test.ts
  tests/error-boundary.test.ts
```

---

### Task 1: Introduce config v2 and remove `fallback_model`

**Files:**

- Create: `cube-workspace/src/gateway.ts`
- Create: `cube-workspace/src/config-migration.ts`
- Modify: `cube-workspace/src/schemas/config.schema.ts`
- Modify: `cube-workspace/src/template/config.yaml`
- Modify: `cube-workspace/src/bootstrap.ts`
- Modify: `cube-workspace/src/index.ts`
- Create: `cube-workspace/tests/config-migration.test.ts`
- Modify: `cube-workspace/tests/home.test.ts`
- Modify: `cube-agent/tests/memory.test.ts`

- [ ] **Step 1: Write failing schema and migration tests.**

  Cover exact gateway IDs, strict v2 parsing, preservation of existing user-facing settings, removal of `fallback_model`, unambiguous Google/OpenRouter/local inference, and incomplete readiness when no route can be inferred. Assert that the migrated serialized YAML contains neither the key nor its previous value.

  ```ts
  export const GatewayIdSchema = z.enum([
    "api_key/google",
    "api_key/openrouter",
    "api_key/openai",
    "subscription/openai",
    "local/ollama",
    "local/lmstudio",
  ]);

  export type GatewayId = z.infer<typeof GatewayIdSchema>;
  export type ApiKeyGatewayId = Extract<GatewayId, `api_key/${string}`>;
  export type LocalGatewayId = Extract<GatewayId, `local/${string}`>;
  export type GatewayOptions = Partial<
    Record<"local/ollama" | "local/lmstudio", { base_url: string }>
  >;
  ```

- [ ] **Step 2: Run the focused tests and confirm the expected failure.**

  Run: `pnpm --filter @cube/workspace test`

  Expected: new imports/schema assertions fail because version 2 and migration do not exist.

- [ ] **Step 3: Implement strict config v2 plus explicit v1 migration.**

  Use separate `LegacyConfigSchema` and `ConfigSchema`; do not make v2 accept `fallback_model`. Export a migration result that exposes whether onboarding is needed without inventing a gateway.

  ```ts
  export type ConfigMigrationContext = {
    hasApiKey(provider: "google" | "openrouter" | "openai"): boolean;
    hasOpenAISubscription: boolean;
    localReachable(provider: "ollama" | "lmstudio", baseUrl: string): Promise<boolean>;
  };

  export type ConfigMigrationResult = {
    config: CubeConfig;
    inferredGateway: GatewayId | null;
  };

  export declare const migrateConfig: (
    input: unknown,
    context: ConfigMigrationContext,
  ) => Promise<ConfigMigrationResult>;
  ```

  `ConfigSchema` represents persisted version 2 and allows `gateway` and `model` to be absent together for onboarding. Add `RunnableConfigSchema` that requires both and is the only type accepted by agent construction. Persist the validated v2 document with the existing atomic store only after migration succeeds. The template must default to version 2 and omit an active `gateway`/`model` when no bundled credential can make it runnable.

- [ ] **Step 4: Remove every production and fixture reference to fallback.**

  Run: `rg -n "fallback_model|fallbackModel" --glob "!docs/superpowers/specs/**" --glob "!docs/superpowers/plans/**" .`

  Expected: no matches.

- [ ] **Step 5: Run tests and commit.**

  Run: `pnpm --filter @cube/workspace test`

  Expected: all workspace tests pass.

  Commit: `git commit -m "feat(cube-workspace): migrate gateway config to v2"`

---

### Task 2: Make `auth.json` the only credential store

**Files:**

- Create: `cube-workspace/src/schemas/auth.schema.ts`
- Create: `cube-workspace/src/store/auth.store.ts`
- Modify: `cube-workspace/src/store/atomic-write.ts`
- Modify: `cube-workspace/src/store/store.ts`
- Modify: `cube-workspace/src/template/auth.json`
- Modify: `cube-workspace/src/bootstrap.ts`
- Modify: `cube-workspace/src/index.ts`
- Create: `cube-workspace/tests/auth.store.test.ts`
- Modify: `cube-workspace/tests/home.test.ts`

- [ ] **Step 1: Write failing auth-store tests with synthetic secrets.**

  Cover an empty valid store, malformed JSON, simultaneous Google/OpenRouter keys, replacing only one provider, preserving an old OpenAI subscription on failed replacement, atomic-write failure, and mode `0o600` on platforms that support it. Assert error strings and serialized diagnostic values do not contain test secrets.

  ```ts
  export const CubeAuthSchema = z.object({
    version: z.literal(1),
    api_keys: z.partialRecord(
      z.enum(["google", "openrouter", "openai"]),
      z.object({ api_key: z.string().min(1) }).strict(),
    ),
    subscriptions: z.object({
      openai: z.object({
        access_token: z.string().min(1),
        refresh_token: z.string().min(1),
        expires_at: z.number().int().nonnegative(),
        account_id: z.string().min(1),
      }).strict().optional(),
    }).strict(),
  }).strict();
  ```

- [ ] **Step 2: Run the focused test and confirm failure.**

  Run: `pnpm --filter @cube/workspace test`

  Expected: auth schema/store imports fail.

- [ ] **Step 3: Implement merge-safe auth operations.**

  ```ts
  export declare class AuthStore {
    constructor(home: HomeManager);
    read(): Promise<CubeAuth>;
    update(mutator: (current: CubeAuth) => CubeAuth): Promise<CubeAuth>;
    getApiKey(provider: ApiKeyProvider): Promise<string | undefined>;
    replaceApiKey(provider: ApiKeyProvider, apiKey: string): Promise<void>;
    getOpenAISubscription(): Promise<OpenAISubscriptionCredential | undefined>;
    replaceOpenAISubscription(credential: OpenAISubscriptionCredential): Promise<void>;
  }
  ```

  Every replacement must re-read, merge one provider, validate the whole document, then atomically rename. Apply restrictive file permissions after creation without weakening Windows behavior.

- [ ] **Step 4: Remove `.env` credential loading from product startup.**

  Delete `loadEnv()` and its public export. `Bootstrap.run()` may seed non-secret templates only. Tests may set process environment for isolated third-party behavior, but no runtime credential path may read Cube-home `.env`.

  Run: `rg -n "loadEnv|\.env" cube-workspace/src cube-agent/src cube-runtime/src cube-tui/src`

  Expected: no credential-loading path remains.

- [ ] **Step 5: Run tests and commit.**

  Run: `pnpm --filter @cube/workspace test`

  Expected: all workspace tests pass without reading the developer home.

  Commit: `git commit -m "feat(cube-workspace): persist provider credentials in auth store"`

---

### Task 3: Add API-key Mastra gateways without changing canonical IDs

**Files:**

- Create: `cube-agent/src/gateways/types.ts`
- Create: `cube-agent/src/gateways/models-dev.delegate.ts`
- Create: `cube-agent/src/gateways/api-key.gateway.ts`
- Create: `cube-agent/src/gateways/index.ts`
- Modify: `cube-agent/src/index.ts`
- Create: `cube-agent/tests/gateways/api-key.gateway.test.ts`
- Create: `cube-agent/tests/gateways/routing.test.ts`

- [ ] **Step 1: Write failing route/auth tests.**

  Instantiate adapters with a temporary `AuthStore`; clear `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY`, and `OPENAI_API_KEY`; then assert `resolveAuth()` returns only the stored synthetic key. Assert router IDs differ for API-key and subscription access while canonical IDs remain identical.

  ```ts
  export const gatewayDescriptors = {
    "api_key/google": { internalId: "cube-api-google", providerId: "google" },
    "api_key/openrouter": { internalId: "cube-api-openrouter", providerId: "openrouter" },
    "api_key/openai": { internalId: "cube-api-openai", providerId: "openai" },
    "subscription/openai": { internalId: "cube-subscription-openai", providerId: "openai" },
    "local/ollama": { internalId: "cube-local-ollama", providerId: "ollama" },
    "local/lmstudio": { internalId: "cube-local-lmstudio", providerId: "lmstudio" },
  } as const satisfies Record<GatewayId, GatewayDescriptor>;

  export const toMastraRouterId = (gatewayId: GatewayId, canonicalModelId: string): string =>
    `${gatewayDescriptors[gatewayId].internalId}/${canonicalModelId}`;
  ```

- [ ] **Step 2: Run the agent tests and confirm failure.**

  Run: `pnpm --filter @cube/agent test`

  Expected: gateway modules are missing.

- [ ] **Step 3: Implement one adapter instance per API-key provider.**

  Compose the installed `ModelsDevGateway` instead of adding another OpenAI-compatible dependency. Each adapter:

  - has a unique internal `id` without `/`;
  - exposes only one provider from `fetchProviders()`;
  - strips its own internal prefix before delegating `buildUrl()` and `resolveLanguageModel()`;
  - implements `resolveAuth()` from `AuthStore`;
  - makes `getApiKey()` throw a sanitized missing-credential error instead of reading env;
  - serializes only `{ id, name }`.

  ```ts
  export declare class CubeApiKeyGateway implements MastraModelGatewayInterface {
    readonly id: string;
    readonly name: string;
    constructor(
      gatewayId: ApiKeyGatewayId,
      auth: Pick<AuthStore, "getApiKey">,
      delegate?: ModelsDevGateway,
    );
    fetchProviders(): Promise<Record<string, ProviderConfig>>;
    buildUrl(routerId: string, env: Record<string, string>): Promise<string | undefined>;
    resolveAuth(request: GatewayAuthRequest): Promise<GatewayAuthResult | undefined>;
    getApiKey(modelId: string): Promise<string>;
    resolveLanguageModel(args: {
      modelId: string;
      providerId: string;
      apiKey: string;
      headers?: Record<string, string>;
    }): Promise<GatewayLanguageModel>;
  }
  ```

- [ ] **Step 4: Prove Mastra chooses the intended gateway.**

  In the routing test, build `GatewayManager` with all adapters. For each stable gateway ID and a canonical fixture ID, assert `resolveModelId(toMastraRouterId(gatewayId, canonicalModelId))` selects the mapped internal gateway and parses the expected provider/model pair.

- [ ] **Step 5: Run tests and commit.**

  Run: `pnpm --filter @cube/agent test`

  Expected: all agent tests pass with env keys absent.

  Commit: `git commit -m "feat(cube-agent): add auth-store API key gateways"`

---

### Task 4: Separate canonical capabilities from gateway availability

**Files:**

- Modify: `cube-workspace/src/model-manager.ts`
- Modify: `cube-workspace/src/schemas/model-catalog.schema.ts`
- Modify: `cube-workspace/tests/model-manager.test.ts`
- Create: `cube-agent/src/gateways/catalog.ts`
- Create: `cube-agent/tests/gateways/catalog.test.ts`

- [ ] **Step 1: Write failing catalog compatibility tests.**

  Assert that Google and OpenRouter keep the current `providers -> models` shape; OpenAI API-key and subscription routes both reuse the same `openai/<model>` capability object; unknown local models receive conservative limits/modalities; and stale incompatible cache data is rebuilt without credentials.

- [ ] **Step 2: Run the focused tests and confirm failure.**

  Run: `pnpm --filter @cube/workspace test`

  Then run: `pnpm --filter @cube/agent test`

  Expected: availability intersection and conservative local enrichment are absent.

- [ ] **Step 3: Make `ModelManager` credential-agnostic.**

  Remove `process.env` provider activation and direct Ollama probing from `cube-workspace`. Retain schema validation, cache read/write, and canonical provider capability refresh only.

  ```ts
  export type GatewayAvailability = {
    gatewayId: GatewayId;
    canonicalModelIds: string[];
  };

  export declare const buildGatewayCatalog: (
    canonical: ModelCatalog,
    availability: GatewayAvailability,
  ) => ModelCatalog;
  ```

  Conservative unknown-local metadata must be stable and explicit: text input/output, no assumed reasoning/tools/attachments, context `128_000`, output `8_192`, no fabricated cost.

- [ ] **Step 4: Run tests and commit.**

  Run: `pnpm --filter @cube/workspace test`

  Then run: `pnpm --filter @cube/agent test`

  Expected: catalog tests pass and no auth value is present in snapshots/cache fixtures.

  Commit: `git commit -m "refactor(cube-agent): separate gateway availability from capabilities"`

---

### Task 5: Add Ollama and LM Studio custom gateways

**Files:**

- Create: `cube-agent/src/gateways/ollama.gateway.ts`
- Create: `cube-agent/src/gateways/lmstudio.gateway.ts`
- Modify: `cube-agent/src/gateways/index.ts`
- Modify: `cube-agent/src/agents/main.agent.ts`
- Modify: `cube-agent/tests/main.agent.test.ts`
- Create: `cube-agent/tests/gateways/ollama.gateway.test.ts`
- Create: `cube-agent/tests/gateways/lmstudio.gateway.test.ts`

- [ ] **Step 1: Write deterministic HTTP-fixture tests.**

  Cover URL normalization, defaults, timeouts/abort, Ollama `/api/tags`, LM Studio `/models`, empty lists, unreachable endpoints, and model construction. Inject `fetch` so no unit test touches a real local server.

  ```ts
  export type LocalGatewayOptions = {
    baseUrl: string;
    fetch?: typeof globalThis.fetch;
    requestTimeoutMs?: number;
  };

  export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
  export const DEFAULT_LMSTUDIO_URL = "http://127.0.0.1:1234/v1";
  ```

- [ ] **Step 2: Run the gateway tests and confirm failure.**

  Run: `pnpm --filter @cube/agent test`

  Expected: local gateway classes are missing and the old Ollama branch still exists.

- [ ] **Step 3: Implement adapters through Mastra gateway interfaces.**

  `OllamaGateway` uses `ollama-ai-provider-v2` for `resolveLanguageModel()`. `LMStudioGateway` composes a `ModelsDevGateway` with an injected `lmstudio` `ProviderConfig` pointing to its OpenAI-compatible base URL. Both expose discovered canonical IDs, use a non-secret sentinel only where the compatible client requires a key argument, and sanitize endpoint errors.

- [ ] **Step 4: Remove transport branching from `main.agent.ts`.**

  Change model construction to accept an already routed ID:

  ```ts
  export const buildModelConfig = (
    routerModelId: string,
    effort?: ReasoningEffort,
  ): AgentModelConfig => ({
    id: routerModelId,
    providerOptions: buildProviderOptions(routerModelId, effort),
  });
  ```

  Delete the `ollamaBaseUrl` parameter, `createOllama` import, and every `ollama/` special case. Preserve provider-specific reasoning options by deriving the canonical provider after stripping a known Cube gateway prefix.

- [ ] **Step 5: Run tests and commit.**

  Run: `pnpm --filter @cube/agent test`

  Expected: all local and existing model configuration tests pass.

  Commit: `git commit -m "feat(cube-agent): route local models through Mastra gateways"`

---

### Task 6: Implement OpenAI subscription OAuth and gateway isolation

**Files:**

- Modify: `cube-runtime/src/auth/openai.ts`
- Modify: `cube-runtime/src/auth/auth-manager.ts`
- Modify: `cube-runtime/src/index.ts`
- Create: `cube-runtime/tests/auth/openai.test.ts`
- Create: `cube-runtime/tests/auth/auth-manager.test.ts`
- Create: `cube-agent/src/gateways/openai-subscription.gateway.ts`
- Modify: `cube-agent/src/gateways/index.ts`
- Create: `cube-agent/tests/gateways/openai-subscription.gateway.test.ts`

- [ ] **Step 1: Write failing OAuth tests with injected clock/network/browser.**

  Test PKCE S256, unique state, exact localhost callback, state mismatch, callback error, code exchange, claim validation, refresh-before-expiry, sanitized failures, successful account replacement, and preservation of old credentials when exchange/validation/write fails. Use a fake HTTP callback request; do not open a real browser in tests.

  ```ts
  export type OpenAILoginHandle = {
    authorizationUrl: string;
    completion: Promise<OpenAISubscriptionCredential>;
    cancel(): Promise<void>;
  };

  export type OpenAIAuthDependencies = {
    fetch: typeof globalThis.fetch;
    now: () => number;
    randomBytes: (size: number) => Buffer;
    openExternalUrl: (url: string) => Promise<void>;
  };

  export declare class OpenAIAuthManager {
    beginLogin(signal?: AbortSignal): Promise<OpenAILoginHandle>;
    getValidCredential(): Promise<OpenAISubscriptionCredential>;
  }

  export interface OpenAISubscriptionCredentialProvider {
    getValidCredential(): Promise<OpenAISubscriptionCredential>;
  }
  ```

  Define `OpenAISubscriptionCredentialProvider` in `cube-agent/src/gateways/types.ts`; `OpenAIAuthManager` implements it structurally from `cube-runtime`. This keeps dependency direction `cube-runtime -> cube-agent -> cube-workspace` and prevents `cube-agent` from importing runtime OAuth code.

- [ ] **Step 2: Run runtime and agent tests and confirm failure.**

  Run: `pnpm --filter @cube/runtime test`

  Then run: `pnpm --filter @cube/agent test`

  Expected: OAuth manager and subscription gateway behavior are absent.

- [ ] **Step 3: Implement browser login and callback lifecycle.**

  Bind only the configured localhost callback, start listening before browser open, validate state before exchange, close the server on success/cancel/error, and keep `completion` pending if the browser is merely closed. Implement platform browser opening with `spawn()` argument arrays, `shell: false`, and `windowsHide: true`; browser-open failure does not cancel the listener because the TUI link remains usable.

- [ ] **Step 4: Implement refresh and commit-after-validation.**

  Decode only the required account claim from the access token, validate expiry/account ID, refresh before expiration, and call `AuthStore.replaceOpenAISubscription()` only after the new record passes the schema. Never delete the previous record on failure.

- [ ] **Step 5: Implement the isolated Mastra subscription adapter.**

  The adapter owns internal ID `cube-subscription-openai`, resolves a fresh bearer token through the injected `OpenAISubscriptionCredentialProvider`, adds only the validated account header, and delegates Responses-model construction with base URL `https://chatgpt.com/backend-api/codex` so the constructed request target is exactly `https://chatgpt.com/backend-api/codex/responses`. It exposes a tested allow-list intersection of supported canonical OpenAI model IDs. Keep protocol constants in this adapter/auth module so future protocol changes cannot affect API-key OpenAI.

- [ ] **Step 6: Run tests and commit.**

  Run: `pnpm --filter @cube/runtime test`

  Then run: `pnpm --filter @cube/agent test`

  Expected: all OAuth and gateway tests pass without real network/browser access.

  Commit: `git commit -m "feat(cube-runtime): add OpenAI subscription authentication"`

---

### Task 7: Register all gateways and add transactional `GatewayService`

**Files:**

- Modify: `cube-agent/src/bootstrap.ts`
- Modify: `cube-agent/src/agents/controller.ts`
- Modify: `cube-agent/src/agents/main.agent.ts`
- Modify: `cube-agent/tests/bootstrap.test.ts`
- Modify: `cube-agent/tests/controller.test.ts`
- Create: `cube-runtime/src/services/gateway.service.ts`
- Modify: `cube-runtime/src/services/model.service.ts`
- Modify: `cube-runtime/src/runtime.ts`
- Modify: `cube-runtime/src/bootstrap.ts`
- Modify: `cube-runtime/src/types.ts`
- Create: `cube-runtime/tests/services/gateway.service.test.ts`
- Modify: `cube-runtime/tests/services/model.service.test.ts`
- Modify: `cube-runtime/tests/runtime.test.ts`

- [ ] **Step 1: Write failing composition and transaction tests.**

  Assert all six adapters are registered in both `Mastra` and `AgentController`; the configured canonical model maps to the correct internal route; a gateway switch preserves the active thread/session; cancellation mutates nothing; persistence happens only after complete validation; apply failure restores config/live state; rollback failure reports both errors.

  ```ts
  export type GatewayChoice = {
    gatewayId: GatewayId;
    group: "api_key" | "subscription" | "local";
    provider: "google" | "openrouter" | "openai" | "ollama" | "lmstudio";
    configured: boolean;
  };

  export type GatewayState = {
    gatewayId: GatewayId;
    model: ModelState;
  };

  export type GatewayDraft = {
    draftId: string;
    gatewayId: GatewayId;
    catalog: ModelCatalog;
    currentModelAvailable: boolean;
  };

  export type GatewaySelection = {
    draftId: string;
    model: ModelSelection;
  };

  export interface GatewayRuntimeAdapter {
    readonly gatewayId: GatewayId;
    isConfigured(): Promise<boolean>;
    validate(
      override?: { apiKey?: string; baseUrl?: string; subscription?: OpenAISubscriptionCredential },
      signal?: AbortSignal,
    ): Promise<void>;
    listCanonicalModelIds(
      override?: { apiKey?: string; baseUrl?: string; subscription?: OpenAISubscriptionCredential },
      signal?: AbortSignal,
    ): Promise<string[]>;
  }

  export type GatewayServiceDependencies = {
    config: Pick<ReturnType<typeof ConfigStore>, "read" | "update">;
    auth: Pick<AuthStore, "read" | "update">;
    adapters: ReadonlyMap<GatewayId, GatewayRuntimeAdapter>;
    catalog: Pick<ModelManager, "getCatalog">;
    applyLiveSelection?: (gatewayId: GatewayId, model: ModelSelection) => void | Promise<void>;
  };

  export type GatewayReadiness =
    | { ready: true; gatewayId: GatewayId; model: ModelState }
    | { ready: false; reason: string; configuredGateway?: GatewayId };

  export declare class GatewayService {
    constructor(dependencies: GatewayServiceDependencies);
    readiness(): Promise<GatewayReadiness>;
    listChoices(): Promise<GatewayChoice[]>;
    listModels(gatewayId?: GatewayId): Promise<ModelCatalog>;
    createStoredDraft(gatewayId: GatewayId, signal?: AbortSignal): Promise<GatewayDraft>;
    createApiKeyDraft(
      gatewayId: ApiKeyGatewayId,
      apiKey: string,
      signal?: AbortSignal,
    ): Promise<GatewayDraft>;
    createLocalDraft(
      gatewayId: LocalGatewayId,
      baseUrl: string,
      signal?: AbortSignal,
    ): Promise<GatewayDraft>;
    beginOpenAILogin(signal?: AbortSignal): Promise<{
      authorizationUrl: string;
      completion: Promise<GatewayDraft>;
      cancel(): Promise<void>;
    }>;
    discardDraft(draftId: string): void;
    commitInitial(selection: GatewaySelection): Promise<GatewayState>;
    set(selection: GatewaySelection): Promise<GatewayState>;
  }
  ```

  `GatewayServiceDependencies` contains stores, adapters, the canonical catalog reader, and an optional `applyLiveSelection`. Drafts are ephemeral, credential-free view objects; the service keeps any candidate key, token, or endpoint replacement in a private pending-draft map and removes it on commit, cancellation, or timeout. Preflight constructs the service without a live applier and may call only `commitInitial()`; the runnable runtime supplies the applier and uses `set()` for persistence plus live apply/rollback.

- [ ] **Step 2: Run agent/runtime tests and confirm failure.**

  Run: `pnpm --filter @cube/agent test`

  Then run: `pnpm --filter @cube/runtime test`

  Expected: gateways are not registered and `GatewayService` does not exist.

- [ ] **Step 3: Register immutable adapters at composition time.**

  `cube-runtime` creates `OpenAIAuthManager`, then passes it to `createCubeMastra()` as an `OpenAISubscriptionCredentialProvider`. `createCubeGateways()` returns both the Mastra record and ordered controller array from the same adapter instances. Pass them to `new Mastra({ gateways })` and `new AgentController({ gateways })`. Initialize the agent with `toMastraRouterId(config.gateway, config.model)` only after readiness is proven.

- [ ] **Step 4: Implement gateway/model transactions.**

  Validate credentials while creating a draft and without inference: Google calls `GET https://generativelanguage.googleapis.com/v1beta/models` with `x-goog-api-key`; OpenRouter calls `GET https://openrouter.ai/api/v1/key` with bearer auth; OpenAI API-key calls `GET https://api.openai.com/v1/models` with bearer auth. Local gateways use their discovery endpoints and OpenAI subscription uses validated token/account claims plus its supported-model probe. Inject `fetch` and explicit timeouts for tests. Retain the current canonical model when it is in draft availability. Otherwise require a model selection before commit. On commit capture previous auth/config/live route, atomically replace any staged credential plus gateway/options/model, apply the route, and restore auth, config, and live state on failure.

- [ ] **Step 5: Restrict `ModelService` to the active gateway.**

  Inject `GatewayService`; `list()` delegates to `gateway.listModels(currentGateway)`. `set()` validates only against that filtered catalog, updates only `model`/`model_config`, and rolls config back if live apply fails. It must never write `gateway`.

- [ ] **Step 6: Run tests and commit.**

  Run: `pnpm --filter @cube/agent test`

  Then run: `pnpm --filter @cube/runtime test`

  Expected: all composition, transaction, rollback, and thread-preservation tests pass.

  Commit: `git commit -m "feat(cube-runtime): coordinate gateway selection transactions"`

---

### Task 8: Add preflight and gateway-aware slash commands

**Files:**

- Create: `cube-runtime/src/preflight.ts`
- Modify: `cube-runtime/src/bootstrap.ts`
- Modify: `cube-runtime/src/slash-commands.ts`
- Modify: `cube-runtime/src/types.ts`
- Modify: `cube-runtime/src/index.ts`
- Create: `cube-runtime/tests/preflight.test.ts`
- Modify: `cube-runtime/tests/slash-commands.test.ts`
- Modify: `cube-runtime/tests/model.feature.test.ts`

- [ ] **Step 1: Write failing preflight and command tests.**

  Cover: complete persisted config skips onboarding; missing key, missing gateway, missing model, unavailable model, or unreachable local endpoint require onboarding; `/gateway` returns serializable choices; `/model` returns only active-gateway models; an empty model list returns a system notice directing `/gateway`; `/model <id>` cannot cross gateways.

  ```ts
  export type CubePreflight = {
    home: HomeManager;
    workspaceRoot: string;
    history: string[];
    preference: PreferenceState;
    readiness: GatewayReadiness;
    gateway: Pick<
      GatewayService,
      | "readiness"
      | "listChoices"
      | "listModels"
      | "createStoredDraft"
      | "createApiKeyDraft"
      | "createLocalDraft"
      | "beginOpenAILogin"
      | "discardDraft"
      | "commitInitial"
    >;
    start(): Promise<CubeRuntime>;
  };

  export type GatewayPromptResult =
    | { kind: "gateways"; request: GatewaySetupRequest }
    | { kind: "models"; gatewayId: GatewayId; catalog: ModelCatalog; current: ModelState };

  export type GatewaySetupRequest = {
    choices: GatewayChoice[];
    current?: GatewayState;
  };
  ```

  Add both `GatewayPromptResult` variants to the existing explicit `PromptResult` union; do not replace its current variants with a catch-all type.

- [ ] **Step 2: Run runtime tests and confirm failure.**

  Run: `pnpm --filter @cube/runtime test`

  Expected: preflight and `/gateway` result kind do not exist; `/model` still returns the whole catalog.

- [ ] **Step 3: Split bootstrap into preflight and runnable construction.**

  `prepareCubeRuntime()` ensures home, migrates/validates stores, resolves readiness, and returns UI-safe state without creating Mastra, an agent, a controller, or a session. `start()` rechecks readiness before constructing the existing composition and runtime.

- [ ] **Step 4: Register `/gateway` and enforce `/model` ownership.**

  Add `/gateway` once to `definitions`; do not add `/login` or `/logout`. Add `gateway: GatewayService` to `SlashCommandContext`. Both argument and interactive `/model` paths must validate against `gateway.listModels(activeGateway)` and preserve `config.gateway` byte-for-byte.

- [ ] **Step 5: Run tests and commit.**

  Run: `pnpm --filter @cube/runtime test`

  Expected: runtime tests pass, including no-runtime-construction preflight assertions.

  Commit: `git commit -m "feat(cube-runtime): add gateway preflight and command flow"`

---

### Task 9: Build TUI onboarding, gateway picker, and OAuth link

**Files:**

- Create: `cube-tui/src/components/gateway-picker.ts`
- Create: `cube-tui/src/components/secret-input.ts`
- Create: `cube-tui/src/components/oauth-login.ts`
- Modify: `cube-tui/src/components/model-picker.ts`
- Modify: `cube-tui/src/screens/chat.screen.ts`
- Modify: `cube-tui/src/app.ts`
- Modify: `cube-tui/src/main.ts`
- Modify: `cube-tui/src/index.ts`
- Create: `cube-tui/tests/gateway-picker.test.ts`
- Create: `cube-tui/tests/secret-input.test.ts`
- Create: `cube-tui/tests/oauth-login.test.ts`
- Create: `cube-tui/tests/onboarding.test.ts`
- Modify: `cube-tui/tests/model-picker.test.ts`
- Modify: `cube-tui/tests/chat.screen.test.ts`
- Modify: `cube-tui/tests/app-session-render.test.ts`

- [ ] **Step 1: Write component tests before implementation.**

  Test group -> provider -> stored credential/configure replacement -> model flow, Escape cancellation at every stage, masked rendering with no secret in output, URL visibility after browser-close simulation, only one visible OSC 8 login URL, endpoint editing, current-model retention, and candidate-gateway model filtering. Use `VirtualTerminal`; assert every rendered line stays within its visible width.

- [ ] **Step 2: Run TUI tests and confirm failure.**

  Run: `pnpm --filter @cube/tui test`

  Expected: new components and onboarding orchestration are absent.

- [ ] **Step 3: Implement overlays using installed pi-tui primitives.**

  Use `SelectList` for groups/providers/models, `Input` or `Editor` with a masked render boundary for secrets, `CancellableLoader` for discovery/OAuth waits, and `hyperlink(authorizationUrl, authorizationUrl)` for the single OSC 8 login link. Reuse `ChatScreen` overlay plumbing and `requestRender()`; do not write directly to stdout.

  ```ts
  export type GatewayPickerResult =
    | { kind: "selected"; selection: GatewaySelection }
    | { kind: "cancelled" };

  export type OAuthLoginView = {
    authorizationUrl: string;
    completion: Promise<GatewayDraft>;
    cancel(): Promise<void>;
  };
  ```

- [ ] **Step 4: Make the shared model picker gateway-scoped.**

  Accept an already filtered catalog and candidate gateway. Do not let the component enumerate unrelated catalog providers. Preserve reasoning selection behavior for the chosen model.

- [ ] **Step 5: Mount the renderer before onboarding/runtime construction.**

  Change startup order to `prepareCubeRuntime()` -> create/mount `ChatScreen` -> if not ready run `screen.pickGateway()` -> create a validated draft and persist its complete selection via `preflight.gateway.commitInitial()` -> call `preflight.start()` -> attach `CubeApp` to the already mounted screen. Add an explicit start option so the screen and terminal are not mounted twice:

  ```ts
  export type CubeAppStartOptions = { screenAlreadyMounted?: boolean };

  export declare class CubeApp {
    start(options?: CubeAppStartOptions): Promise<void>;
  }
  ```

  When `screenAlreadyMounted` is true, replace the setup submit handler through `ChatScreen.setSubmitHandler()`, subscribe to runtime events, and render current state without calling `mount()` or `startTerminal()` again.

  Ensure a runnable persisted config bypasses `pickGateway()` entirely.

- [ ] **Step 6: Route `/gateway` through the same flow.**

  Handle `PromptResult.kind === "gateways"` in `CubeApp`, call the same screen method used by onboarding, and invoke `runtime.gateway.set()` only with a complete draft/model selection. Selecting configured `subscription/openai` always starts a fresh login so account switching works. Cancellation calls `discardDraft()` and returns to the prompt without a notice or mutation; do not add separate Enter, copy, or reopen-browser actions beside the single clickable URL.

- [ ] **Step 7: Run tests and commit.**

  Run: `pnpm --filter @cube/tui test`

  Expected: all TUI tests pass, including virtual-terminal assertions for no duplicated prompt/indicator and no secret/url duplication.

  Commit: `git commit -m "feat(cube-tui): add gateway onboarding and switching"`

---

### Task 10: Contain operational errors and logger output

**Files:**

- Modify: `cube-agent/src/logger.ts`
- Modify: `cube-agent/tests/logger.test.ts`
- Modify: `cube-runtime/src/services/prompt.service.ts`
- Modify: `cube-runtime/src/services/gateway.service.ts`
- Modify: `cube-runtime/src/types.ts`
- Modify: `cube-runtime/tests/services/prompt.service.test.ts`
- Modify: `cube-runtime/tests/services/gateway.service.test.ts`
- Modify: `cube-tui/src/main.ts`
- Create: `cube-tui/tests/error-boundary.test.ts`

- [ ] **Step 1: Write failing error-boundary tests.**

  Simulate missing credentials, 401, 429/quota, network timeout, invalid model, stale catalog, local server unavailable, OAuth failure, config write failure, and provider code calling `console.warn`. Assert one role-`system` notice, idle prompt state, no fallback request, no process exit, and no raw pino/third-party line in virtual terminal output.

- [ ] **Step 2: Run focused tests and confirm failure.**

  Run: `pnpm --filter @cube/agent test`

  Then run: `pnpm --filter @cube/runtime test`

  Then run: `pnpm --filter @cube/tui test`

  Expected: at least the provider-warning and pre-mount error cases leak outside the system-message path.

- [ ] **Step 3: Normalize operational failures.**

  Add one sanitizer that maps known provider/auth/catalog/local errors to actionable `RuntimeNotice` messages and retains the original error only in the file logger. Quota/model errors suggest `/gateway` or `/model`; they never select another route. Ensure each async failure stops the working indicator and restores idle state.

- [ ] **Step 4: Complete file-only redaction.**

  Add pino redaction paths for `api_key`, `apiKey`, `access_token`, `refresh_token`, `authorization`, headers, callback queries, request/response token bodies, and nested error config. Gateway adapters must not use Mastra discovery helpers with console output. The TUI top-level catch may use stderr only if renderer creation/mount itself failed; after mount it calls `screen.showNotice()` and keeps the app alive.

- [ ] **Step 5: Run tests and commit.**

  Run: `pnpm --filter @cube/agent test`

  Then run: `pnpm --filter @cube/runtime test`

  Then run: `pnpm --filter @cube/tui test`

  Expected: all package tests pass with no credential or logger text in captured terminal output.

  Commit: `git commit -m "fix(cube): render gateway failures as system notices"`

---

### Task 11: Migrate development credentials and run end-to-end verification

**Files:**

- Modify only if verification exposes a defect: files owned by the failing task above
- Local untracked state: `C:\Users\TSP\.cube\auth.json`, `C:\Users\TSP\.cube\config.yaml`

- [ ] **Step 1: Prove all checked-in credentials/templates are empty.**

  Run: `git grep -n -E "(sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,})" -- ":!docs/superpowers/plans/2026-09-04-gateway-authentication.md"`

  Expected: no secret-like value matches. Provider variable names in documentation/tests are acceptable only without values.

- [ ] **Step 2: Copy the current developer Google and OpenRouter credentials once.**

  Request filesystem approval for the local Cube home before changing `C:\Users\TSP\.cube\auth.json` or `C:\Users\TSP\.cube\config.yaml`. Run a local-only Node command that reads the existing development `.env`, calls the built `AuthStore.replaceApiKey()` once for `google` and once for `openrouter`, and prints only the provider names migrated. Do not add this migration to `Bootstrap.run()`, do not keep a migration script in the product, and do not print values. Preserve other keys/subscriptions already present.

- [ ] **Step 3: Keep Google active in config and validate both stored routes without inference.**

  Set `gateway: api_key/google` with the current canonical Google model through `GatewayService`, then run readiness for Google and OpenRouter. Verify that the auth file parses while displaying only provider names and that config contains no `fallback_model`.

- [ ] **Step 4: Run focused and full automated verification.**

  Run:

  ```powershell
  pnpm --filter @cube/workspace test
  pnpm --filter @cube/agent test
  pnpm --filter @cube/runtime test
  pnpm --filter @cube/tui test
  pnpm --workspace-concurrency=1 --recursive run test
  pnpm exec tsc --build --force
  node --input-type=module -e "await import('./cube-workspace/dist/index.js'); await import('./cube-agent/dist/index.js'); await import('./cube-runtime/dist/index.js'); await import('./cube-tui/dist/index.js'); console.log('public-entry-smoke: ok')"
  ```

  Expected: all tests/builds pass and the final command prints `public-entry-smoke: ok`.

- [ ] **Step 5: Run temporary-home onboarding smoke.**

  Start Cube with a temporary home containing the empty checked-in templates. Verify the TUI mounts before setup, shows group/provider/key or local endpoint flow, cancellation preserves files, entering a synthetic invalid key produces one system message, and no raw pino/console line appears.

- [ ] **Step 6: Run live provider smoke checks with short prompts and timeouts.**

  Use `/gateway` to select Google, verify `/model` shows only Google availability, send `Reply exactly CUBE_GOOGLE_OK`, and record success/failure without response headers. Switch to stored OpenRouter, verify `/model` shows only OpenRouter availability, send `Reply exactly CUBE_OPENROUTER_OK`, then switch back to Google. If Ollama or LM Studio is running, verify discovery and one `CUBE_LOCAL_OK` inference; otherwise record each local smoke as skipped with the connection reason.

- [ ] **Step 7: Run OpenAI subscription smoke when a test account is available.**

  Select `/gateway -> subscription -> OpenAI`; verify the browser opens automatically, the same URL remains one clickable TUI link, closing/reopening via that link still completes, login replaces the account only after validation, `/model` is OpenAI-subscription scoped, and `Reply exactly CUBE_OPENAI_SUBSCRIPTION_OK` succeeds. If no test account is available, report this item explicitly as not verified; do not claim full subscription completion from unit tests alone.

- [ ] **Step 8: Final secret, fallback, diff, and status audit.**

  Run:

  ```powershell
  rg -n "fallback_model|fallbackModel" --glob "!docs/superpowers/specs/**" --glob "!docs/superpowers/plans/**" .
  git diff --check
  git status --short
  git diff --stat
  git diff --cached --stat
  ```

  Expected: no fallback matches, no whitespace errors, no home auth/config file tracked, no generated credentials in the diff, and only intentional source/test changes remain.

- [ ] **Step 9: Commit verification-only fixes if any.**

  If verification required a source fix, rerun the affected focused tests plus Steps 4 and 8, then commit only those fixes:

  Commit: `git commit -m "test(cube): verify gateway authentication flows"`

  If verification required no source changes, do not create an empty commit.

## Completion Gate

Implementation is complete only when every automated check passes, Google and OpenRouter live smokes both pass using `~/.cube/auth.json`, temporary-home onboarding is verified, and any unavailable local/OpenAI subscription smoke is explicitly reported as skipped. A release remains outside this plan.

## API Verification References

- Google Gemini Models API: https://ai.google.dev/api/models
- OpenRouter current-key API: https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key
- OpenAI list-models API: https://platform.openai.com/docs/api-reference/models/list
