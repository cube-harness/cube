# Gateway Authentication and Runtime Selection

For the catalog/capability and OAuth lifecycle follow-up, see
[Strategy-scoped Model Catalog and OAuth Lifecycle](2026-09-08-strategy-model-catalog-and-oauth-lifecycle-design.md).
That specification supersedes the corresponding flat-catalog, hardcoded-capability,
and logout sections here; the implementation/verification notes below predate the follow-up.

Date: 2026-09-04
Status: Current-format storage and Google E2E verified. User confirmed OpenAI login/model listing; account inference remains unverified. LM Studio live inference was skipped because its server was unavailable. See the plan for test results and outstanding user-edit mismatches.

### API provider expansion (approved 2026-09-07)

The `api_key` strategy supports Google, OpenRouter, OpenAI, Anthropic, Groq, xAI,
Mistral, DeepSeek, Moonshot AI, Nvidia, Poolside, Z.AI, Z.AI Coding Plan, Alibaba,
Alibaba Coding Plan, and Hugging Face. `API_KEY_PROVIDERS` in
`cube-workspace/src/constants.ts` owns their canonical IDs and display labels.
Gateway IDs, auth validation, routing descriptors, and the picker derive from it.

All providers use the existing Mastra-native API strategy. Coding Plan providers
remain API-key routes with separate stored keys and native endpoints, not OAuth
login. Native Mastra metadata owns endpoint/protocol/model overrides;
Cube supplies the selected provider's key from `auth.json` explicitly.

Google/OpenRouter/OpenAI retain their existing credential/discovery checks. New
providers list canonical catalog models without assuming a common `/models` or
key-validation endpoint. A stored nonempty key is not proof of validity or model
entitlement; inference errors use the existing system-message boundary. No paid
inference is triggered by onboarding. OAuth and local behavior is unchanged.

### Grok Build extension (approved 2026-09-07)

`oauth/xai` is Grok Build, not xAI API billing or Grok web cookies. It shares
`OAuthGateway` with OpenAI; there are still three strategy instances. Anthropic
OAuth is deferred. Runtime auth lives in `auth/grok.ts` (device protocol) and
`auth/auth-manager.ts` (stored credential refresh), with no new gateway class.

The device flow requests `auth.x.ai/oauth2/device/code`, opens the returned
verification URL (the live endpoint returns `accounts.x.ai`), and leaves that
single clickable URL plus the confirmation code in the existing TUI component.
Polling honors pending/slow-down, expiry and cancellation. Successful login
opens model selection automatically; tokens remain staged until selection commits.
`auth.json.oauth.xai` stores access/refresh tokens and expiry, while `config.yaml`
stores `gateway: oauth/xai` and the canonical `xai/...` model ID. Existing keys
and OpenAI credentials are retained. Each inference request reads fresh auth.

Account model discovery uses `cli-chat-proxy.grok.com/v1/models`; inference uses
the same backend's `/responses` through the installed Mastra adapter. Canonical
capabilities are reused, with a small OAuth-only `grok-build` capability entry
when that backend model is returned (not renamed to API model `grok-build-0.1`).
Only Grok 4.5 models expose explicit reasoning effort; Grok Build uses its default.
Quota/spending limits render system notices, without model fallback or app crash.

Reference: https://github.com/decolua/9router (grok-cli OAuth and transport).
Automated HTTP fixtures are not proof of account entitlement or live inference.

## Goal

Add one coherent gateway-selection system to Cube for API-key providers,
oauth-backed providers, and local providers without changing the canonical
model IDs or capability ownership already used by the model catalog.

`~/.cube/config.yaml` remains the durable source of truth for the active gateway,
model, and model settings. `~/.cube/auth.json` becomes the durable credential store
for both development and packaged use. Cube does not maintain a separate
development authentication path.

## Scope

This phase covers:

- three user-facing gateway groups: `api_key`, `oauth`, and `local`;
- simultaneous storage of API keys for multiple providers;
- direct Google and OpenRouter API-key operation and live smoke verification;
- OpenAI OAuth login, token refresh, account replacement, and model use;
- local Ollama and LM Studio discovery and model execution through Mastra custom
  gateway adapters;
- a `/gateway` command for configuring and switching the active gateway;
- first-run onboarding only when the persisted configuration is not runnable;
- `/model` filtering by the active gateway;
- removal of `fallback_model` from configuration and runtime behavior;
- recoverable system-message errors with no provider or logger output leaking into
  the active TUI.

This phase does not add:

- Anthropic oauth support; it is a later phase;
- multiple accounts for one oauth provider;
- multiple API keys, rotation, or load balancing for one API-key provider;
- quota tracking, automatic fallback, or automatic gateway switching;
- a proxy service equivalent to 9router;
- a release or packaging workflow.

## Selected Architecture

Cube registers exactly three Mastra gateway strategy instances: `api_key`,
`oauth`, and `local`. Providers are selected within each strategy.
The runtime `GatewayService` resolves the persisted strategy/provider selection.

The selected approach is:

1. `CubeApiKeyGateway` reads provider keys from `auth.json` and delegates provider
   URL and language-model construction to Mastra/models.dev behavior.
2. `OAuthGateway` owns oauth transport; this phase supports OpenAI
   OAuth credentials and its Responses endpoint.
3. `LocalGateway` owns Ollama and LM Studio endpoint normalization, discovery,
   and model construction, keeping separate URLs for the two providers.

`GatewayService` exposes configured gateways, validates readiness, filters
   models, and performs transactional selection changes.

All three strategies are registered when the runnable Mastra composition is created. A
gateway change selects another registered route and updates the live model; it
does not require restarting Cube or rebuilding the current conversation.

### Rejected alternatives

A single mutable Cube gateway that claims bare IDs such as `openai/*` was rejected.
It makes the same canonical model ambiguous when both OpenAI API-key and OpenAI
oauth credentials exist.

An `.env` bridge was also rejected. Generating or loading a home-directory `.env`
would duplicate secrets, retain two credential sources, and make development
exercise a different path from packaged use. The installed Mastra version supports
gateway-owned authentication through `resolveAuth()`, so this bridge is unnecessary.

## Persisted Configuration

Configuration uses one current schema, without a format-version field:

```yaml
gateway: api_key/google
model: google/gemini-3.7-flash
model_config:
  reasoning_effort: medium

gateway_options:
  local/ollama:
    base_url: http://127.0.0.1:11434
  local/lmstudio:
    base_url: http://127.0.0.1:1234/v1
```

The fields have these responsibilities:

- `gateway` is the active credential and transport route.
- `model` remains a canonical `provider/model` ID.
- `model_config` remains the model-specific option set.
- `gateway_options` stores non-secret provider settings, initially local base URLs.

Gateway IDs use the stable form `<group>/<provider>`, including:

```text
api_key/google
api_key/openrouter
api_key/openai
oauth/openai
local/ollama
local/lmstudio
```

The internal Mastra router ID may include an adapter prefix, but this internal ID is
never persisted as `config.yaml.model` and never replaces canonical model IDs in the
catalog or user interface.

`fallback_model` is removed completely. It is absent from schemas, templates,
runtime selection, and agent model configuration. Provider exhaustion never triggers hidden inference with a
different model.

## Credential Store

`~/.cube/auth.json` stores credentials for every configured provider:

```json
{
  "api_keys": {
    "google": { "api_key": "..." },
    "openrouter": { "api_key": "..." },
    "openai": { "api_key": "..." }
  },
  "oauth": {
    "openai": {
      "access_token": "...",
      "refresh_token": "...",
      "expires_at": 0,
      "account_id": "..."
    }
  }
}
```

API keys are keyed by provider. Adding or replacing one provider key must preserve
every other provider key. Selecting another gateway does not delete credentials.
This retains the current ability to configure Google and OpenRouter at the same
time while keeping only one active runtime gateway.

Phase 1 stores one API key per provider and one OpenAI OAuth account. A new
login or key replacement updates only that provider after the new credential has
been validated.

The auth store must:

- validate structure before returning credentials;
- use atomic replacement when writing;
- never render or log secrets;
- redact API keys, bearer tokens, refresh tokens, authorization headers, callback
  query parameters, and token-exchange bodies;
- apply restrictive file permissions where the operating system supports them;
- leave the previous valid file intact when a write fails.

The checked-in `auth.json` template remains empty of credentials. Packaged users
therefore enter onboarding on first run unless they already have a valid Cube home.

## Model Catalog Contract

The existing `providers -> models` catalog shape and canonical capability entries
remain the primary contract. Capability data belongs to the model, not the
credential route. For example, `openai/gpt-*` has one capability record even when
the model can be reached through both `api_key/openai` and
`oauth/openai`.

Gateway adapters own availability:

- the API-key adapter exposes the selected provider's models from the Mastra/model
  registry;
- the OpenAI OAuth adapter exposes only models supported by its transport;
- the Ollama adapter discovers models actually pulled from `/api/tags`;
- the LM Studio adapter discovers models served by its OpenAI-compatible `/models`
  endpoint.

`GatewayService` intersects gateway availability with canonical catalog metadata.
Local models are enriched from canonical metadata when possible; unknown local
models receive conservative capability metadata rather than being dropped.

`model-catalog.json` remains a derived cache. A stale or schema-invalid cache
may be discarded and rebuilt. No credential is written into the catalog.

## Startup and Onboarding

`cube-runtime/src/bootstrap.ts` owns preparation and runtime construction in one
place. The prepared stores, auth manager, catalog manager, and gateway service are
reused after onboarding; there is no separate startup-flow module.

1. Ensure the Cube home and seed non-secret templates.
2. Validate the current `config.yaml` and `auth.json` formats; do not migrate them.
3. Resolve the configured gateway and model without creating the Mastra agent.
4. If gateway, credential/endpoint, and model are sufficient, create the normal
   runtime and skip onboarding.
5. Otherwise mount the dedicated `OnBoardScreen` in `on-board.screen.ts` (no chat
   prompt, footer, or working indicator). Reuse the concrete gateway picker component
   also used by `/gateway`; do not create another flow/controller module.
6. Reread the committed config without bootstrapping home or recreating services.
   Create the Mastra runtime only after a complete valid selection is persisted,
   remove onboarding, then construct and mount `ChatScreen`.

The presence of an API key or a reachable local server alone is not enough to skip
onboarding. Cube also needs an active gateway and a model available through that
gateway. Conversely, a complete runnable configuration must never show onboarding.

Invalid or incomplete state is recoverable in the TUI. It must not fall through the
top-level `console.error` path merely because a provider is missing, offline, or
unauthorized.

## `/gateway` Interaction

`/gateway` is the only command for connection configuration and switching. Separate
`/login` and `/logout` commands are not added.

The interactive flow is:

1. Select `api_key`, `oauth`, or `local`.
2. Select a provider in that group.
3. Reuse a stored credential/endpoint or configure a replacement.
4. Discover and validate available models without making a paid inference call.
5. Retain the current canonical model when it is available through the candidate
   gateway; otherwise open the shared model picker filtered to the candidate
   gateway.
6. Atomically persist the candidate gateway and complete model selection.
7. Apply the corresponding internal Mastra route to the live runtime.
8. Report success only after persistence and live apply both succeed.

API-key selection lists all providers already present in `auth.json` and offers a
path to add another provider. A missing key opens a masked input. Replacing a key
changes only that provider entry.

Local selection first probes the configured URL or the provider default. A user may
edit the URL, and the successful value is stored in `gateway_options` rather than
`auth.json`.

Cancellation at any step leaves the active gateway, model, runtime, and persisted
configuration unchanged.

## OpenAI OAuth Login

Selecting `oauth/openai` starts a new login, which also provides account
switching:

1. Generate state, PKCE verifier/challenge, redirect URI, and authorization URL.
2. Start the localhost callback listener.
3. Attempt to open the authorization URL in the default browser.
4. Render that same URL as an OSC 8 clickable link in the TUI.
5. Keep the URL visible and the callback listener waiting if the browser is closed.
6. Verify callback state, exchange the authorization code, and validate the
   returned account/token data.
7. Atomically replace the previous OpenAI OAuth credential only after all
   validation succeeds.
8. Refresh availability and complete the gateway/model transaction.

The TUI does not add separate Enter, copy, or reopen-browser controls. The visible
clickable URL is the recovery path when the automatically opened browser is closed.

Token refresh occurs before an expired token is used. Refresh failure preserves the
stored credential record, emits a recoverable system message, and allows the user
to select `oauth/openai` again to reauthenticate.

OpenAI documents this browser-login, localhost-callback, cached-credential, and
automatic-refresh behavior for Codex clients. It does not document a general public
third-party oauth gateway API. The Cube adapter is therefore isolated and
treated as experimental so a protocol change affects only that adapter. 9router is
an implementation reference, not Cube's runtime dependency or authoritative API
contract.

## `/model` Interaction

`/model` is strictly scoped to the active gateway:

- `api_key/google` shows only Google models;
- `api_key/openrouter` shows only OpenRouter models;
- `oauth/openai` shows only OpenAI models supported by the oauth
  transport;
- `local/ollama` shows only models pulled on the configured Ollama server;
- `local/lmstudio` shows only models currently served by LM Studio.

`/model` updates only `model` and `model_config`. It never changes `gateway`, never
selects a model from another configured provider, and never silently switches
credentials.

When a gateway change needs another model, `/gateway` invokes the same picker with
the candidate gateway as its filter. Gateway and model are persisted together only
after that picker completes. If a gateway has no available models, Cube renders a
system message directing the user to `/gateway`; it does not display models from a
different gateway as substitutes.

## Runtime Apply and Rollback

A gateway or model change is a transaction:

1. Capture the previous persisted and live selection.
2. Validate the complete candidate without mutating live state.
3. Persist the candidate atomically.
4. Apply the internal Mastra route and model options to the live agent/session.
5. If live apply fails, restore the previous live state and persisted selection.
6. Surface both the original and rollback error if persistence rollback also fails.

Changing an API key or oauth account follows the same commit discipline:
the old credential remains usable until the replacement has been validated and
written successfully.

No selection or credential validation sends an inference prompt. The first paid or
quota-consuming inference remains the user's next actual prompt.

## Error and Logging Boundary

Expected operational failures become typed runtime notices and are rendered through
the existing system-message path. This includes:

- missing or invalid API keys;
- OAuth cancellation, state mismatch, callback failure, or token-exchange failure;
- refresh-token failure;
- quota exhaustion and rate limiting;
- provider/network timeouts;
- unavailable or removed models;
- unreachable Ollama or LM Studio endpoints;
- catalog refresh and cache-parse failures;
- config/auth persistence failures.

These failures leave Cube alive and return the prompt to idle state. Quota or model
availability errors advise `/gateway` or `/model` but do not invoke a fallback.

Pino remains file-only and redacted. No runtime path writes structured logs to
stdout or stderr while the TUI owns the terminal. Gateway discovery is wrapped by
Cube rather than relying on a helper that prints provider failures with
`console.warn`. The only permissible top-level stderr failure is an unrecoverable
error before the terminal renderer itself can be mounted.

## Package Ownership

| Package | Ownership |
| --- | --- |
| `cube-workspace` | Current config/auth/catalog schemas, atomic persistence, Cube-home paths, and non-secret templates. |
| `cube-agent` | Mastra gateway adapters, provider/model construction, capability enrichment, logger redaction, and live model application. |
| `cube-runtime` | `GatewayService`, bootstrap/readiness contract, `/gateway` command, transaction coordination, and typed runtime notices. |
| `cube-tui` | Onboarding and gateway/model picker overlays, masked key input, clickable OAuth URL, loaders, and system-message rendering. |

The slash-command registry remains the sole owner of `/gateway` and `/model`
metadata. TUI components receive serializable view data and callbacks; they do not
read config, auth files, or Mastra gateways directly.

## Current-format-only storage

Config, auth, model catalog, and workspace registry use their current schemas
without format-version fields. There is no legacy parser, gateway inference, or
automatic config rewrite on startup. `ConfigSchema` allows incomplete onboarding
state; `RunnableConfigSchema` extends it by requiring gateway and model, not by
introducing a second storage format.

Preflight reads and validates config directly. Missing gateway/model opens
onboarding; invalid files produce a sanitized system notice without overwriting
user data. Only explicit setup/model selection writes the corresponding settings.
Thread metadata never overrides the active `config.yaml` gateway/model pair.

## Testing and Verification

All tests use fake credentials and deterministic provider fixtures unless a test is
explicitly designated as a local developer smoke test.

Coverage includes:

- current-schema bootstrap/read/write, explicit gateway selection, and rejection
  of unsupported config fields;
- auth schema, multiple-provider key preservation, provider-only replacement,
  atomic writes, malformed files, and redaction;
- Mastra `resolveAuth()` reading `auth.json` without environment credentials;
- Google and OpenRouter API-key route/model resolution;
- OpenAI PKCE/state/callback/token exchange, refresh, failed replacement, and
  account switching;
- Ollama and LM Studio endpoint normalization, discovery, unavailable servers, and
  model construction;
- canonical capability reuse across OpenAI API-key and oauth routes;
- `/gateway` cancellation, incomplete selection, commit, live apply, and rollback;
- `/model` showing only active-gateway models and never changing the gateway;
- first-run onboarding when configuration is insufficient and no onboarding when
  configuration is runnable;
- system-message rendering for provider/auth/catalog errors;
- virtual-terminal assertions that errors and pino records do not leak outside the
  renderer;
- preservation of the current thread and existing flow across live gateway/model
  changes.

Final verification requires:

1. focused package tests for workspace, agent, runtime, and TUI;
2. the full recursive test suite;
3. a forced TypeScript project build;
4. public-entry and startup smoke checks;
5. an interactive first-run/onboarding smoke using a temporary Cube home;
6. a live Google prompt using a credential explicitly stored in `auth.json`;
7. a live switch to OpenRouter, `/model` catalog check, and prompt;
8. available local Ollama and LM Studio discovery/inference smoke checks;
9. an OpenAI OAuth login and prompt smoke when a test account is available;
10. a final Git diff/status review confirming no secret or generated credential is
    tracked.

Live smoke tests must use short prompts, explicit timeouts, and report whether they
were skipped. Completion cannot be claimed from unit tests alone.

## Acceptance Criteria

- A runnable existing config starts without onboarding.
- An end-user install with no credentials starts onboarding in the TUI.
- Development and packaged Cube both read credentials from `~/.cube/auth.json`.
- Google and OpenRouter credentials can coexist, switch through `/gateway`, and pass
  live smoke tests without exposing their values.
- OpenAI OAuth login auto-opens a browser and leaves one clickable URL in the
  TUI until completion or cancellation.
- Reauthentication can replace the active OpenAI OAuth account without
  deleting the previous credential on failure.
- Ollama and LM Studio use Mastra custom gateway adapters instead of the current
  Ollama-only branch in agent model construction.
- Canonical model IDs and capability ownership remain stable.
- `/model` displays only models available through the active gateway and never
  changes gateways.
- `fallback_model` no longer exists in schemas, templates, runtime, or active
  user configuration.
- Provider, quota, authentication, local-server, and catalog errors appear as system
  messages without crashing Cube or corrupting the TUI.
- Pino and gateway diagnostics do not write through the TUI terminal stream.
- Failed or cancelled changes preserve the previous credential, config, runtime
  model, and session.

## References

### Anthropic OAuth extension (2026-09-09)

- Add `oauth/anthropic` within the existing OAuth strategy, using authorization
  code + PKCE and a loopback callback. No Agent SDK runtime or extra strategy.
- Show an informational risk note only while Anthropic is selected in the OAuth
  provider picker. Enter starts login directly: no accept/reject step and no
  risk message appended to the transcript.
- The note identifies experimental, unsupported subscription compatibility,
  possible terms violations/access restrictions, and use at the user's own risk.
  It is a product notice, not a guarantee of legal immunity.
- Store credentials in `auth.json` only on selection commit. Refresh within five
  minutes of access expiry; preserve account replacement/logout race guards.
- Use native Mastra Anthropic Messages serialization with OAuth bearer headers;
  preserve Cube tools and instructions. API-key Anthropic remains unchanged.
- Discover model IDs from Anthropic, including pagination, then join exact IDs
  against models.dev. Do not invent capabilities for unknown models.
- Logout removes only `oauth.anthropic` credentials/catalog. Cancel, timeout,
  rejection, and discovery failure never replace saved configuration.
- Local login waiting is limited to five minutes; this is distinct from the
  provider-issued access token expiry. Real account login/inference must be
  verified separately from mocked HTTP tests.

- Mastra custom gateway documentation:
  https://mastra.ai/models/gateways/custom-gateways
- Installed Mastra gateway interfaces and manager behavior:
  `@mastra/core@1.63.2`
- OpenAI Codex authentication documentation:
  https://learn.chatgpt.com/docs/auth
- 9router implementation reference:
  https://github.com/decolua/9router
