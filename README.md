<p align="center">
  <img src="docs/assets/cube.png" alt="Cube logo" width="144" />
</p>

**Install Cube → start coding**

https://github.com/user-attachments/assets/856c43d7-2313-4c14-bc01-8beb8637d4b4

# Cube

A terminal coding agent that works in your project, with your choice of models.
Read and edit files, run commands, connect external tools, and delegate focused work
without leaving the terminal.

[Website](https://cube-agent.pages.dev) · [Documentation](docs/index.md) · [Getting started](docs/getting-started.md)

## Install

**Windows x64 · PowerShell**

```powershell
irm https://cube-agent.pages.dev/install.ps1 | iex
```

**macOS Apple Silicon / Intel · Linux / WSL x64**

```sh
curl -fsSL https://cube-agent.pages.dev/install.sh | bash
```

These installers download a platform-specific package with its own Node.js runtime
and verify its SHA-256 checksum. A separate Node.js installation is not required.
Review remote scripts before executing them.

**Alternatively, use npm or pnpm · requires Node.js 18+ for the launcher**

```sh
npm install -g @cube-harness/cli
# or
pnpm add -g @cube-harness/cli
```

The npm package is a launcher that downloads the packaged application, not a
separate engine. Cube can offer application updates at startup while preserving
your configuration and conversation history.

## Start in your project

```sh
cd path/to/your-project
cube
```

Trust the workspace, then configure a gateway if you have not already done so:

- **API key:** OpenAI, Anthropic, Google, OpenRouter, Groq, xAI, and other supported providers.
- **OAuth:** OpenAI, xAI, Anthropic, or Google. Availability depends on the provider,
  account, and plan; subscription access is separate from API billing.
- **Local:** Connect an existing Ollama or LM Studio server.

Then describe the task in plain language, for example:

```text
Explain how authentication works in this project and point out the main risks.
```

Use `/init` to ask Cube to create or update the project's `AGENTS.md`, review the
result, then `/reload` to load it into the current instruction snapshot.

## What Cube provides

- **Model choice:** API-key, OAuth, and local gateways, capability-aware catalogs,
  runtime model switching, and provider-specific reasoning controls.
- **File edits you can inspect:** Targeted edits, stale-edit checks, themed diffs,
  and Codex-format `apply_patch` for compatible models.
- **Command execution:** Reasons and working directories, bundled ripgrep,
  background processes, live logs, and explicit stop controls.
- **Approvals and permissions:** Workspace trust, per-tool Ask / Allow / Deny,
  and configurable workspace path boundaries.
- **Extensible workflows:** Project/global skills, `$skill` and `@file` autocomplete,
  plus MCP tools over stdio or HTTP.
- **Focused delegation:** Built-in `explore` and `worker` roles, custom Markdown
  subagents, private child context, and optional Git worktree isolation.
- **Conversation continuity:** SQLite-backed resume/fork, tool-output pruning,
  automatic/manual context compaction, and durable project memory with optional
  BM25/vector hybrid retrieval.
- **Interactive terminal UI:** Streaming Markdown, reasoning/tool transcripts,
  searchable pickers, themes, and a terminal pet.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `/gateway` | Configure credentials or switch access strategy/provider. |
| `/model`, `/effort` | Choose an available model and reasoning effort. |
| `/new`, `/resume`, `/fork` | Start, reopen, or branch a conversation. |
| `/init`, `/reload` | Generate project guidance and refresh supported context sources. |
| `/permissions` | Change workspace boundaries and tool approval policies. |
| `/skills`, `/mcp` | Manage skill availability and external tool connections. |
| `/tasks`, `/subagents` | Inspect background work, logs, child results, and transcripts. |
| `/status`, `/compact` | Inspect usage or request context compaction when eligible. |
| `/theme` | Change the terminal syntax-highlighting theme. |
| `/exit` | Exit Cube and stop runtime-owned processes. |

See [Commands & Shortcuts](docs/commands.md) for the full list and keybindings.

## Your configuration, one home

Cube keeps application data under `~/.cube`, separate from your project and the
installed application:

| File | Owns |
| --- | --- |
| `config.yaml` | Gateway/model selections and application settings. |
| `auth.json` | API keys and OAuth credentials. |
| `permission.json` | Workspace trust and per-workspace tool policies. |
| `mcp.json` | Global MCP server connections. |
| `SOUL.md` | Personal communication style. |
| `memories/` | Conversation database and durable project memory. |

Use project `AGENTS.md` for repository-specific instructions. Skills and custom
subagents support project and global locations; see [Skills](docs/skills.md) and
[Subagents](docs/subagents.md) for the exact paths and precedence.

Never commit credentials. Commands execute on your computer with your account's
access; workspace trust and path validation are **not an OS sandbox**. Review
approvals before allowing untrusted commands. See [Tools & Permissions](docs/tools-permissions.md).

## Learn more

- [Gateways](docs/gateways.md) and [models](docs/models.md)
- [Instructions and reload](docs/instructions.md)
- [MCP connections](docs/mcp.md) and [background tasks](docs/background-tasks.md)
- [Context management](docs/context.md) and [memory & sessions](docs/memory-sessions.md)
- [Complete configuration reference](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)

## Development

From a local checkout, use Node.js **22.13.0+** and pnpm:

```sh
pnpm install
pnpm build
pnpm dev
```

The core dependency flow is `cube-tui → cube-runtime → cube-agent → cube-workspace`:
terminal presentation, runtime orchestration, Mastra-backed execution, and shared
configuration/storage. `cube-cli` supplies the npm launcher.

Use `pnpm typecheck` for TypeScript checks, or `pnpm --filter @cube/<package> test`
for a package's tests. Native distribution builds use `pnpm package:app` on a
supported build host; see [Windows packaging](scripts/WINDOWS.md) and
[Unix packaging](scripts/UNIX.md).

## License

[Apache License 2.0](LICENSE).
