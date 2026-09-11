# Gateway Authentication Implementation Plan

Updated: 2026-09-07. Current implementation and verification checklist.

## Grok Build extension — 2026-09-07

- Implemented `oauth/xai` in the shared OAuth strategy: device login, refresh,
  staged account/model selection, account model discovery, and native Responses transport.
- Existing onboarding and `/gateway` share the Grok URL/code screen. `/model`
  uses the active gateway; no Anthropic OAuth, fallback, migration, or new dependency.
- Auth updates are serialized per path within the process to protect account
  replacement from in-flight refresh writes; the race has a regression test.
- Verification: forced TypeScript build, public entry imports and `git diff --check` passed.
  Four-package suite: 243/255 passed; the same 12 previously deferred failures remain.
- Live anonymous device-code request returned HTTP 200; the implemented flow accepted
  `accounts.x.ai` and cancelled cleanly without opening a browser or saving credentials.
  Authenticated account model discovery and inference still require a user smoke test.

## Scope and ownership

- Exactly three Mastra strategy instances: `api_key`, `oauth`, `local`.
- `cube-workspace`: config/auth/catalog schemas and stores, provider IDs/labels,
  Cube-home paths, canonical capabilities, and empty credential templates.
- `cube-agent`: native Mastra adapters, routing, logging, lifecycle.
- `cube-runtime`: bootstrap, discovery, staged selection, persistence, rollback,
  slash-command handlers, sanitized notices.
- `cube-tui`: separate `on-board.screen.ts`, reusable gateway/model picker,
  masked key input, clickable OAuth URL, system messages.

`config.yaml` is authoritative for gateway/model/settings. `auth.json` stores
credentials for development and packaged use. `model-catalog.json` is a
credential-independent capability cache. Each has one current schema without a
format-version field. There is no legacy parser or automatic conversion.
`fallback_model` is removed. External protocol versions remain unchanged.

## Current-format-only storage

- [x] Delete compatibility code and its tests/exports.
- [x] Remove format-version fields from config/auth/catalog schemas and templates.
- [x] Align workspace registry template with its existing schema.
- [x] Derive runnable config by requiring gateway/model on the current schema.
- [x] Bootstrap validates config without gateway inference or config rewriting.
- [x] Update all producers and test fixtures end to end.
- [x] Test empty-home bootstrap, explicit selection, cache read/rebuild,
  invalid-config notices, and no config rewriting during startup checks.
- [x] Verify existing Cube-home files without changing credentials/model/settings;
  request filesystem approval before writing outside the repository.
- [x] Run forced build, focused tests, full suite, and public-entry smoke.

### Current-format verification results

- Forced TypeScript build and public-entry imports passed. No compatibility source,
  export, compiled output, or format-version producer remains in the application.
- Config/catalog tests 4/4, startup/model tests 9/9, app/onboarding tests 22/22 passed.
- With filesystem approval, removed only the top-level format-version field from
  existing config/auth/catalog/workspace files. Validated all four current schemas
  and verified every other value unchanged. One-time cleanup script was removed.
- Real Google smoke passed in a disposable home: empty setup -> selection commit ->
  reread config -> runtime -> exact assistant reply -> shutdown -> restart ready.
  Source config/auth stayed byte-for-byte unchanged during the smoke.
- OAuth rename: strategy/group `oauth`, route `oauth/openai`, internal ID
  `cube-oauth`, `OAuthGateway`, and `auth.json.oauth` are consistent across source,
  templates, tests, and documentation. No compatibility alias or parser is retained.
- Existing home auth was updated with filesystem approval, preserving every token
  and API key; config gateway/model/settings were unchanged. The one-time helper
  and obsolete compiled gateway files were removed.
- Forced build and 77 focused gateway/auth/onboarding tests passed after the rename.
- Bootstrap consolidation: preparation and construction share stores, auth/catalog
  managers, and GatewayService in `cube-runtime/src/bootstrap.ts`. Startup seeds
  home once; onboarding commits then starts the same prepared runtime without a
  second preparation pass. The separate preparation module and compiled output
  were deleted; its tests now live in `cube-runtime/tests/bootstrap.test.ts`.
- Forced build, public-entry imports, and 48 startup/gateway/TUI tests passed.
  The integration check creates a real runtime with temporary home/SQLite, verifies
  a single bootstrap call and the same GatewayService, then switches Google to
  Ollama and checks model/config. Discovery HTTP is mocked; no live inference is
  claimed for this refactor.
- Full suite (outside sandbox): workspace 12/13, agent 49/52, runtime 59/63,
  TUI 109/113: 229/241 passed, with only the 12 deferred baseline failures remaining.
  Moonshot uses native ID `moonshotai` and display label `Moonshot`; provider order
  and `API Key` capitalization are preserved, with matching tests.

## API-key strategy

`API_KEY_PROVIDERS` in `cube-workspace/src/constants.ts` owns provider IDs/labels.
Provider schema/types live in `auth.schema.ts`; gateway schema/types live in
`config.schema.ts`. No separate gateway declaration module is needed.
Supported providers: Google, OpenRouter, OpenAI, Anthropic, Groq, xAI, Mistral,
DeepSeek, Moonshot AI, Nvidia, Poolside, Z.AI, Z.AI Coding Plan, Alibaba,
Alibaba Coding Plan, Hugging Face. Schema/routing/UI derive from this list.

All use the same `CubeApiKeyGateway`. Mastra owns native SDK selection, protocol,
base URL, and model overrides. Cube supplies the selected key from `auth.json`,
never via environment-credential fallback. Coding Plans have separate API-key
routes/credentials; they do not use OAuth login.

All API-key providers use models.dev for the catalog. No provider-specific
credential-validation or model-list request runs during setup/readiness. Check key
presence/schema locally; provider rejection surfaces on actual inference as a system message.

Follow-up verification (2026-09-10): removed `discoverApiKeyModels` and its caller.
TypeScript build and 50 focused catalog/bootstrap/native-gateway tests passed.
Provider fixtures now use the current registry; no per-provider setup probe remains.
Stored nonempty keys do not prove entitlement; inference errors become system messages.
Onboarding does not trigger paid inference.

## OAuth and local strategies

OpenAI OAuth uses PKCE/state, loopback callback, token exchange/refresh. Selecting
a configured OAuth provider uses its saved credential directly, with no account
submenu or browser login. Switch accounts with `ctrl+d` logout, then select the
unconfigured provider to auto-open login and leave the URL clickable in the TUI.
Callback success proceeds without extra Enter. Credentials are staged until model
selection commits. Account replacement preserves API keys.

OAuth discovery uses account/token headers and canonical capability filtering.
The native Responses adapter targets the Codex backend. Preserve the user's working
discovery `client_version` setting.

One `LocalGateway` handles Ollama and LM Studio. Local URLs are non-secret config
values; unavailable servers yield notices.

## End-to-end flow

1. Bootstrap seeds only absent files, never replacing existing user data.
2. Bootstrap validates current stores and readiness without creating an agent/session.
   Incomplete gateway/model state opens `OnBoardScreen`.
3. Setup collects a key/endpoint/OAuth credential and creates a draft.
4. User selects model/reasoning; cancellation discards the draft.
5. Commit stores credentials and gateway/model/options atomically per file.
   Failed live application rolls back auth/config/runtime state.
6. Initial setup creates runtime, then ChatScreen. `/gateway` uses the same setup
   component inside existing chat and preserves the thread.
7. `/model` shows only the active gateway's catalog and never changes gateway.
8. Provider/auth/network/quota errors become system messages, not terminal logs.

## Verification boundaries

Google extension (2026-09-10): add the existing `oauth/google` route across schemas,
bootstrap, credential manager, staged gateway setup and the shared provider picker.
Use public Gemini CLI OAuth + managed Code Assist project setup. Keep native Google
SDK serialization and adapt only Code Assist request/response envelopes within
`OAuthGateway`; no new gateway strategy or UI screen. Join quota-bucket model IDs
with models.dev capabilities. Validate login/cancel/expiry, refresh/logout races,
streamed tools/reasoning, catalog isolation and existing gateway regression paths
at the end. Do not claim real-account verification from mocked HTTP checks.

Verification: TypeScript build passed. Focused gateway suite: 83/84 passed;
the native API-provider fixture still expects Poolside, which the current
`API_KEY_PROVIDERS` edit removes. Google protocol/lifecycle/catalog checks passed.
Real Google account sign-in/inference has not been exercised.

Anthropic extension (2026-09-09): reuse `OAuthGateway`, the loopback callback, and
the staged gateway commit/logout path. Add only the provider-specific token
exchange/refresh and Messages authentication. Show a passive risk note in the
OAuth provider picker, with no confirmation step or transcript notice. Discover
account model IDs before the existing models.dev capability join. Verify with
focused auth, native adapter, lifecycle, and catalog tests at the end; real
subscription login/inference remains a separate interactive check.

- Controlled tests cover auth storage, routing, callback, refresh, cancellation,
  rollback, filtering, onboarding, URL rendering, and shutdown.
- Native request tests use installed SDKs with mocked HTTP; these are not proof of
  successful inference with real keys for every provider.
- Earlier live Google/OpenRouter switching and Ollama inference passed. User
  confirmed OpenAI login and Astra listing; account inference is not implied.
- LM Studio live inference was skipped when no server was reachable.
- User explicitly deferred unrelated baseline failures. Distinguish those from
  new regressions and report conflicting user edits accurately.
- Preserve prompt/theme/provider-order/build-script edits. No release, packaging,
  merge, or unrelated edits. Never print credentials.

## Commands

```text
pnpm --filter @cube/tui exec tsc --build --force
pnpm --workspace-concurrency=1 --no-bail --recursive run test
git diff --check
```

Also check temporary-home onboarding/restart/switching. Existing-home checks must
preserve credentials, selected gateway/model, history, and memory; inspect only
sanitized metadata.
