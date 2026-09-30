# Cube Design

Cube is a local, interactive coding-agent CLI. A terminal UI talks to one runtime, which owns one Mastra session. The session runs a single coding agent against the current workspace, with credentials, memory, and preferences stored under `~/.cube`.

The UI never calls a model or touches the filesystem itself. It submits prompts and renders events. Everything that can change a thread, a model, or a file goes through `CubeRuntime`.

## Packages

pnpm workspace, Node `>=22.13.0`, ESM with NodeNext imports (`.js` suffixes). Dependency direction is one way:

```
cube-cli  →  published launcher only
cube-tui  →  cube-runtime  →  cube-agent  →  cube-workspace
```

| Package | Role |
| --- | --- |
| `@cube/workspace` | Home directory, Zod schemas, atomic stores, model catalog, project context discovery. No Mastra, no UI. |
| `@cube/agent` | Mastra composition: coding agent, controller, tools, gateways, skills, context compaction. |
| `@cube/runtime` | Process lifecycle. Services for prompt, thread, model, gateway, preference, and memory. Slash commands. OAuth. |
| `@cube/tui` | Alternate-screen TUI (`@earendil-works/pi-tui`) and the `cube` binary entry. |
| `@cube-harness/cli` (`cube-cli`) | Zero-dependency launcher. Downloads a verified standalone binary; it does not contain the agent. |

`cube-tui` is the only package that knows about screens. `cube-agent` is the only package that constructs Mastra. `cube-workspace` is the only package that knows on-disk formats.

## Startup

`startTui` (`cube-tui/src/main.ts`) does three things, in order:

1. Optional self-update. A verified download exits `75` so the launcher can restart. `CUBE_SKIP_UPDATE=1` skips the check.
2. `prepareCubeRuntime()` seeds `~/.cube` if needed, reads config and prompt history, and reports gateway readiness. The chat screen can mount before a model is configured.
3. Onboarding collects a gateway and model when readiness is false. `bootstrap.start()` then builds Mastra and returns a live `CubeRuntime`. `CubeApp` subscribes and owns the screen until shutdown.

Shutdown is ordered. The runtime aborts the session, drops file previews, waits for in-flight streams to finish writing, then closes LibSQL. Storage export is drained before the database closes; Mastra's default exporter does not wait.

A fresh process never resumes a half-open thread. If the restored session has active messages it is detached; an empty bound thread is deleted. The user resumes explicitly with `/resume`.

## Turn path

```
PromptEditor
  → CubeApp.submitPrompt
  → PromptService.submit
       slash command → PromptResult (picker, notice, thread change, …)
       otherwise     → Session message
  → Mastra AgentController
  → input processors → model → tools → stream events
  → CubeRuntime.subscribe → ChatScreen
```

`PromptResult` is the boundary between runtime and UI. Slash commands do not render themselves. They return a kind (`gateways`, `models`, `threads`, `skills`, `usage`, `notice`, …) and `CubeApp` opens the matching overlay.

While a turn is running, a new prompt is queued as a follow-up instead of starting a second run. Interrupt (`CubeRuntime.interrupt`) aborts the session, or cancels a manual compaction if that is what is in progress.

`ask_user` is the one tool that suspends into the UI. Escape resumes it with `{ cancelled: true }` so the model loop can continue. Any other pending suspension is aborted with the turn.

## Agent

There is one interactive agent, `cube-agent`, built with Mastra's coding agent and driven by `AgentController` (`cube-controller`). The controller has a single mode (`default`). Builtin task and plan tools are disabled. `ask_user` is replaced by Cube's suspension tool.

System instructions are three layers, rebuilt together on reload:

1. `SOUL.md` from the home directory (capped; default template is seeded once).
2. Execution rules: workspace root, shell (`cmd.exe` on Windows, `/bin/sh` elsewhere), no TTY, UTF-8 file edits only.
3. `<agents_instructions>`, injected by an input processor and not stored as conversation history.

Instruction sources, closest directory first:

- `AGENTS.md` from the working directory up to the workspace root.
- At the project root only: `.agents/AGENTS.md`, `.cube/AGENTS.md`, `.claude/AGENTS.md`, `.codex/AGENTS.md`.
- `~/.cube/AGENTS.md` as global scope.

On conflict, the project scope closest to the file wins over parent and global. Non-conflicting instructions are all kept. Equal-scope conflicts are left for the model to ask about.

Discovery is incremental. After `read_file`, `list_files`, `grep`, `edit_file`, `write_file`, or `apply_patch`, the processor walks ancestors of the touched path and loads any `AGENTS.md` not already explored. Misses are cached; a new file needs `/reload`. `/reload` re-reads the startup snapshot and, when requested, previously discovered paths. Discovered instructions are checkpointed with the thread so a resume does not forget them and does not treat them as a new user message.

Skills come from Mastra's skill loader. Project dirs are `.agents/skills`, `.cube/skills`, `.claude/skills`, `.codex/skills`. Global skills live in `~/.cube/skills`. `config.yaml` `skills.disabled` is a path list. Project skills are enabled on the workspace; global skills are enabled on the agent. A snapshot is taken once per request context.

## Tools and permissions

Reads are Mastra workspace tools, renamed and rooted at the project:

- `read_file`, `list_files`, `grep` — workspace filesystem only. Other workspace tools stay off.

Mutations and processes are Cube tools, also rooted at the project:

- `edit_file` and `write_file`, or `apply_patch` when the model id is OpenAI GPT-5+ / Codex. A model sees one mutation style, not both.
- `execute_command`, `get_process`, `kill_process`.
- `fetch` (Mastra web fetch) and the controller's `ask_user`.

`edit_file` matches with a sequence of replacers (exact, line-trimmed, block anchor, whitespace, indentation, escapes) and writes only when one match is unambiguous. Mutations propose a preview first. Approval of `edit_file`, `write_file`, or `apply_patch` is rejected unless that preview is still live; decline and turn-end discard it. Files over 2 MiB are not editable. Writes are atomic. Paths are resolved against the workspace realpath; symlink escapes and Windows ADS-style suffixes are rejected.

Commands are not an OS sandbox. They run on the host, with `cwd` confined to the workspace, no TTY, a default 120s deadline (max 600s), and a 256 KiB output cap. Process ids are Cube handles, not OS pids. Only processes this runtime spawned can be polled or killed.

Permission default is allow for the `other` category. `config.yaml` `permissions.require_approval_for` sets individual tools to `ask`. Naming any of `edit_file`, `write_file`, or `apply_patch` asks for all three, so a model switch cannot skip the prompt. Retired tool names (`mastra_workspace_*`, `list_file`, `create_file`, `delete_file`, `file_stat`) fail closed: mutations and `execute_command` are denied until `config.yaml` is corrected. `approve_prefix` grants that tool for the rest of the session.

## Gateways

A gateway id is `api_key/<provider>`, `oauth/<provider>`, or `local/ollama` | `local/lmstudio`. The catalog model id stays canonical (`openai/gpt-5.4`). Mastra sees a routed id (`cube-api/…`, `cube-oauth/…`, `cube-local/…`). `toMastraRouterId` refuses a model that does not belong to the selected gateway.

API-key providers: Google, OpenAI, Anthropic, xAI, DeepSeek, Moonshot, OpenRouter, Mistral, Nvidia, Z.AI, Z.AI Coding Plan, Alibaba, Alibaba Coding Plan, Hugging Face, Groq.

OAuth: OpenAI, xAI (Grok Build), Anthropic, Google. PKCE flows live in `cube-runtime/src/auth`. Tokens persist in `auth.json` and are refreshed by the auth manager before a call. Removing the active credential aborts the session and drops queued follow-ups.

Local base URLs default to `127.0.0.1:11434` (Ollama) and `127.0.0.1:1234/v1` (LM Studio), overridable under `gateway_options`.

Reasoning effort (`none` through `max`, plus `default`) is stored in `model_config` and translated per provider in `buildModelConfig`. Changing the model invalidates the context-limit cache.

The model catalog is cached in `model-catalog.json` for 24 hours. `/model` and `/gateway` read that catalog; an empty catalog tells the user to pick another gateway.

## Memory and context

One LibSQL file: `~/.cube/memories/memory.sqlite`. It holds Mastra threads, messages, and optional vectors. Threads are keyed by workspace root as `resourceId`.

Memory keeps the full thread (`lastMessages` is unbounded) and drops incomplete tool calls. Title generation, working memory, and semantic recall follow `config.yaml` and are off unless explicitly enabled. Semantic recall requires both vector and embedder. Embedder requires vector. The title model may be `inherit`, which uses the active agent model.

Compaction is separate from Mastra's message window. `CubeContext` estimates tokens as `ceil(chars / 4)` and refuses to estimate when a message contains media. Budget comes from the catalog context window minus `reserve_tokens` (and any requested output). A second agent, `cube-compactor`, summarizes with the same model and no tools.

Two mechanisms:

- **Prune**, after a clean turn: drop old tool results beyond the recent user turns, using the OpenCode-style 40k threshold. `skill` and `skill_read` outputs are protected. Already-pruned ids are the frontier; unknown media stops the scan.
- **Compact**, manual via `/compact` or when the estimate crosses the policy: summarize older turns, keep `keep_recent_ratio`, and record a checkpoint (`summary`, first retained message, pruned tool ids). The summary is not a user message. Manual compact is skipped below `manual_min_ratio`.

`/fork` copies the thread and its context checkpoint. `/new` detaches. `/delete` of the active thread resets the screen.

## Terminal UI

`TuiAltScreen` plus `ProcessTerminal`. `ChatScreen` is the only session screen: message list, prompt editor, status line, working indicator. Overlays (model, gateway, thread, theme, title, skills, approval, suspension) are modal and return values to `CubeApp`.

`OnBoardScreen` covers first-run gateway setup and the update prompt. It is not used again once a runtime exists.

The screen is a projection of `RuntimeDisplayState` plus local chrome (theme, title fields, status-line fields). It does not invent thread ids or token counts. Instruction stats (SOUL size, AGENTS.md file count) are pushed from the runtime after each submit and on start.

Keybindings go through one table (`cube.turn.interrupt`, `cube.app.exit`, `cube.transcript.toggle`, …). Slash names are suggestions from the runtime, not a second command parser in the UI.

Themes affect syntax highlighting only. Title and status line are ordered field lists persisted in `config.yaml` (`model`, `workspace`, `threadId`, `agentMd`, and the status set).

Prompt history is `~/.cube/history.jsonl`, separate from thread transcripts.

## Home directory

`HomeManager` resolves `~/.cube` (or `cubeHome` in tests). First launch copies missing templates; existing files are never overwritten.

| Path | Contents |
| --- | --- |
| `config.yaml` | Gateway, model, effort, theme, title, status line, telemetry, memory, permissions, disabled skills. |
| `auth.json` | API keys and OAuth credentials. |
| `SOUL.md` | Persona injected as the first system instruction. |
| `AGENTS.md` | Global instructions. |
| `history.jsonl` | Prompt editor history. |
| `workspace.json` | Trusted workspace registry. |
| `mcp.json` | MCP client config seed. |
| `model-catalog.json` | Cached provider models. |
| `memories/memory.sqlite` | Threads, messages, vectors. |
| `logs/` | Runtime logs. Correlation ids only; prompts and tool bodies are not logged. |
| `skills/` | Global skills. |

`config.yaml` is strict Zod: unknown keys fail. A document may omit `gateway` and `model` (onboarding). `RunnableConfigSchema` requires both before `start()`. Errors shown in the UI are redacted (`Bearer`, `sk-`, `AIza`, token fields). Stacks and request bodies stay in the log.

Telemetry is opt-in (`telemetry: true`) and exports traces into the same LibSQL store.

## Distribution

`cube-tui` builds to `dist/main.js` (`bin: cube`). `scripts/build-binary.mjs` produces the standalone binary published for the launcher. `cube-cli` checks a local cache, otherwise downloads the verified binary for Windows x64, macOS arm64/x64, or Linux x64 from R2, then execs it.

Dev bypasses the binary: `pnpm dev` runs the TUI through `tsx`.

## Invariants

- One session per process. No background agent, no parallel turns.
- Workspace root is a hard boundary for file tools and command `cwd`. It is not a sandbox for the shell itself.
- File approvals require a live preview from the same tool call.
- Instructions are scoped data, not a new user turn, and are not rewritten into stored history.
- Model ids in config and UI are canonical. Router prefixes exist only inside Mastra.
- Shutdown must not close SQLite while a stream or trace export is still writing.
- UI copy of provider errors never includes credentials.
