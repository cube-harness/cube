# Commands & Shortcuts

Navigate Cube without confusing application commands with model instructions.

<a id="slash-commands"></a>

## Slash Commands

Type / at the start of the prompt to open autocomplete. Commands operate on Cube; $ mentions activate skills, while @ mentions reference workspace files.

| Command | Purpose |
| --- | --- |
| `/gateway` | Configure or switch API-key, OAuth or local access. |
| `/model [model-id] [--effort level]` | Pick a model or select an available ID directly. |
| `/effort [level]` | Pick or set reasoning effort for the current model. |
| `/new` | Prepare a fresh conversation; persist it on the first prompt. |
| `/resume [thread-id]` · `/threads` | Open a saved conversation; /threads is an alias. |
| `/fork [title]` | Copy the current conversation into a new branch. |
| `/rename <title>` | Rename the active conversation. |
| `/delete [thread-id]` | Choose a saved conversation to delete, or specify its ID. |
| `/init` | Ask the model to create or update project AGENTS.md. |
| `/reload` | Reload instruction/memory snapshots, custom-agent catalog, MCP configuration and memory retrieval settings. Not a generic config reload. |
| `/compact` | Request a continuation summary if threshold and safe-cut checks pass. |
| `/status` · `/usage` | Show session usage and provider-reported OAuth limits. |
| `/skills` | Enable or disable discovered skills. |
| `/permissions` | Edit the current workspace's tool policy. |
| `/mcp` | Inspect/configure connections and restart MCP servers. |
| `/tasks` | Inspect live command logs and stop background processes. |
| `/subagents` | Inspect delegated jobs, transcripts, results and worktree changes. |
| `/theme [name]` | Choose a syntax-highlighting theme. |
| `/title [field,...]` | Configure terminal-title fields. |
| `/statusline [field,...]` | Configure footer fields. |
| `/copy` | Copy the last assistant response as Markdown. |
| `/exit` | Exit Cube and stop runtime-owned background work. |

<a id="keybindings"></a>

## Keybindings

Keys depend on the active picker. Follow its visible hints; a shortcut while typing is not necessarily the same action as inside a dialog.

| Key | Action |
| --- | --- |
| Enter | Submit the prompt or apply/select in the active picker. |
| Shift+Enter / Alt+Enter | Insert a newline; support depends on the terminal. |
| Tab | Apply autocomplete, including directory traversal for @ paths. |
| Ctrl+T | Expand/collapse reasoning and tool transcripts. |
| Esc | Close a picker; otherwise cancel a queued prompt or interrupt a turn. When scrolled up, return to bottom. |
| Ctrl+C | Cancel/interrupt as appropriate; exit when no work remains. |
| y / n / p | Approve, decline, or use the command-prefix remember option when offered. |
| Ctrl+K | Open pending child approvals/input without permanently locking the parent's prompt. |
| Ctrl+D in /gateway | Remove a key or log out the selected OAuth provider. |
| Space in /skills | Stage an enable/disable choice; Enter applies the staged changes together. |
| k in /tasks | Stop the selected process. |

<a id="mentions"></a>

## File Mentions

Use @ to autocomplete a workspace path. Cube provides the file reference, not its entire contents. The model decides whether to call read_file or another available tool; mentioning a path does not bypass permissions.

**Prompt**

```text
Review @src/server.ts and explain its error handling.
```

<a id="appearance"></a>

## Theme, Title & Status Line

Use the corresponding picker to see supported fields. These commands save preferences to config.yaml and update the UI. The theme controls syntax highlighting in Markdown/code and diff content; added/deleted diff lines have separate surfaces.

**config.yaml**

```yaml
theme: default
app_title: [workspace, threadTitle]
status_line: [workspace, model, threadId]
```

<a id="related-config"></a>

## config.yaml Reference

Settings related to this guide. Merge examples into your existing file; omitted settings use Cube defaults. See [applying changes](/docs/configuration#defaults).

| Field | Type / range | Default | Behavior |
| --- | --- | --- | --- |
| `theme` | Non-empty string | `default` | Syntax-highlighting theme. Use /theme to select a supported installed theme. |
| `app_title` | Non-empty string[] | `["workspace", "threadId"]` | Ordered terminal-title fields: model, workspace, threadTitle, threadId, status. Use /title; unknown strings do not create new fields. |
| `status_line` | Non-empty string[] | `["workspace", "model"]` | Ordered footer fields: model, workspace, agentMd, threadTitle, threadId, status. Use /statusline. |
