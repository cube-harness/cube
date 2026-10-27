# Subagents

Delegate bounded work to a private-context child, with explicit approvals and evidence.

<a id="roles"></a>

## Explore & Worker

The built-in explore role investigates and synthesizes findings without file-mutation tools. worker implements an approved bounded change and reports actual verification. They have their own role instructions and task context, not the parent's entire conversation.

Delegation adds model calls and instruction overhead. Cube's guidance is to do ordinary lookups and small edits directly, and invoke a child when the user explicitly asks or approves delegation. Explore and worker are reserved role names; a custom Markdown file cannot replace their roles.

The model invokes an available role tool by its name, such as explore or worker. These are one-shot background assignments, not another interactive parent session with its own compaction loop. A returned job UUID means accepted, not finished or successful.

**Prompt**

```text
Use explore to compare the authentication flow across the API and UI.
Report exact files, evidence, and unresolved questions; do not edit files.
```

<a id="configuration"></a>

## Shared Defaults & Precedence

subagents in config.yaml supplies concurrency, model, reasoning_effort and timeout_ms. Missing optional custom-role settings fall back to shared config values, then Cube defaults; the model default is inherit from the parent. Built-in roles can use the shared model/effort settings without changing their fixed role instructions.

The default concurrency is 2. Extra jobs queue FIFO, rather than failing simply because both slots are occupied. A dependent assignment must wait for its prerequisite; concurrency alone does not resolve overlapping file edits or task dependencies.

timeout_ms: 0 means no deadline. A positive timeout starts with execution, includes approval/input waits, and excludes queue time. Expensive or stuck children can still be interrupted explicitly.

**config.yaml**

```yaml
subagents:
  concurrency: 2
  model: inherit
  reasoning_effort: medium
  timeout_ms: 0
```

<a id="custom-agents"></a>

## Custom Agent Markdown

`<workspace>` is the directory where Cube was started. Custom roles are individual Markdown files, not skill directories. Supported sources are:

- **Global:** `~/.cube/agents/<role>.md`, available across workspaces.
- **Project:** `<workspace>/.agents/agents/<role>.md` and `<workspace>/.cube/agents/<role>.md`, available only in that workspace.
- **Built-in:** explore and worker, supplied by Cube; these reserved roles cannot be replaced by user Markdown.

For a custom name, precedence is project .cube/agents over project .agents/agents over global ~/.cube/agents. The winning file replaces the whole role definition; fields from shadowed files are not merged. An invalid winning file makes that custom role unavailable rather than falling back to a lower-priority file. Cube does not discover roles from ~/.agents/agents, .claude/agents, .codex/agents or an agents subfolder inside a skill.

Create or edit a role file, then run /reload to refresh the role catalog; restarting Cube also reloads it. The filename defines the role/tool name: lowercase, starting with a letter, using letters/digits/_/-, at most 57 characters.

description and non-empty Markdown instructions are required. The other fields below are optional. tools is an allowlist; disallowedTools removes tools. skills limits which skills are permitted, not an instruction to activate them all. mcpServers limits server access. Unknown fields are rejected.

Choose an actually available provider/model before setting a model override. Overrides resolve within the parent's gateway strategy; the model field does not add credentials or switch to an unrelated strategy. A role cannot bypass workspace policy or gain recursive delegation simply by declaring a skill.

**Project example: `<workspace>/.agents/agents/reviewer.md` — use `~/.cube/agents/reviewer.md` for a global role**

```markdown
---
description: Review an approved code change and report concrete risks with evidence.
# Optional model override: use an available provider/model ID.
# model: <provider>/<model-id>
reasoning_effort: high
tools: [read_file, list_files, execute_command]
disallowedTools: [write_file, edit_file, apply_patch]
skills: []
mcpServers: []
isolation: none
---

Review only the assigned change. Do not modify files.
Return findings with paths/symbols, checks actually executed, and unresolved risks.
```

| Markdown field | Meaning |
| --- | --- |
| description | Required non-empty role description for discovery/tool selection. |
| model | Optional concrete model ID or inherit; overrides shared model. |
| reasoning_effort | Optional supported effort; overrides shared effort. |
| tools | Optional unique tool-name allowlist. |
| disallowedTools | Optional unique tool names to remove. |
| skills | Optional allowed skill names; [] permits none. |
| mcpServers | Optional allowed server names; [] permits none. |
| isolation | none (shared directory) or worktree (managed Git checkout). |

<a id="approvals-results"></a>

## Approvals, Results & Transcripts

A waiting child shows an approval/input hint above the prompt editor. Use Ctrl+K to open pending child interactions; the parent prompt remains available when you close the child picker. Confirm the child name, tool, arguments and directory before deciding.

/subagents lists jobs owned by the current parent thread. Enter inspects a job; r opens Result, t Transcript, s Status and d worktree Changes. k interrupts live work, n reads the next page when offered, and Esc returns. Completion is delivered to the parent model without requiring a polling loop.

Result is the child's final report or failure. Transcript is a bounded snapshot of saved messages and tool calls/results in its private SQLite thread, not a live token stream. A child that fails with HTTP 429 can still have useful tool evidence saved before the error. A wrong-tool read does not prove that evidence is absent.

manage_subagent uses the job UUID returned at acceptance. Do not substitute the private native thread ID or use manage_task, which is only for command processes. Old jobs can be inspected after resume but are read-only when no execution is attached.

**manage_subagent · model tool arguments**

```text
{"action":"get","id":"<job UUID>","view":"result"}
{"action":"get","id":"<job UUID>","view":"transcript"}
```

<a id="worktree"></a>

## Worktree Isolation

isolation: none shares the project's filesystem. Worktree isolation creates a separate managed Git checkout for the assignment; the child's cwd is that checkout. This separates file changes, not OS permissions, networking, or all process side effects.

Review Changes and the child's verification before integrating anything into the original project. Integration is deliberate, not an automatic merge or permission to overwrite user edits. Retained worktrees can be removed from /subagents with x and confirmation after active work is stopped; removal discards unintegrated/generated checkout content.

<a id="related-config"></a>

## config.yaml Reference

Settings related to this guide. Merge examples into your existing file; omitted settings use Cube defaults. See [applying changes](/docs/configuration#defaults).

| Field | Type / range | Default | Behavior |
| --- | --- | --- | --- |
| `subagents.concurrency` | Integer: 1–32 | `2` | Maximum simultaneously executing delegated jobs. Extra jobs queue FIFO; waiting approvals still occupy a slot. |
| `subagents.model` | Non-empty model ID or inherit | `inherit` | Shared child-model default. A custom role's model wins; inherit uses the parent model captured for the assignment. |
| `subagents.reasoning_effort` | Optional effort enum | `Not set` | Shared child reasoning default. A custom role can override it; otherwise inherit the parent's setting when no shared value is supplied. |
| `subagents.timeout_ms` | Integer: 0–9,007,199,254,740,991 | `0` | 0 disables the deadline. Positive values include execution and approval/input waits, but not queue time. |
