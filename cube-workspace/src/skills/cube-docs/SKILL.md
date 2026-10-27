---
name: cube-docs
description: "Read Cube's official documentation when answering questions about its setup, gateways, commands, permissions, skills, MCP, subagents, context or memory. Not needed for ordinary coding in the user's project."
---

# Cube Documentation

Read the relevant guide before explaining or changing Cube settings. Raw Markdown
is available at `https://cube-agent.pages.dev/docs/<page>.md`; the website is
`https://cube-agent.pages.dev/docs`.

| Question | Page |
| --- | --- |
| Installation, onboarding, updates | `getting-started` |
| API keys, OAuth, local servers | `gateways` |
| Models, reasoning effort, usage | `models` |
| Slash commands and shortcuts | `commands` |
| Tool approvals, workspace trust | `tools-permissions` |
| SOUL.md, AGENTS.md, snapshots, /reload | `instructions` |
| Skill sources, activation, enable/disable | `skills` |
| External MCP configuration and authentication | `mcp` |
| Background commands, logs, manage_task | `background-tasks` |
| Delegation, custom roles, manage_subagent, worktrees | `subagents` |
| Token budgets, pruning, compaction | `context` |
| Sessions, memory Markdown files, recall, embeddings | `memory-sessions` |
| All config.yaml fields, defaults and inheritance | `configuration` |
| Diagnosing errors | `troubleshooting` |

Start with the relevant page, not the whole documentation set. If unsure which
guide applies, read `index.md` first. Follow a related guide only when needed.

Use an available MCP web-reading tool, or `execute_command` to retrieve Markdown:

```powershell
(Invoke-WebRequest -UseBasicParsing -Uri 'https://cube-agent.pages.dev/docs/configuration.md').Content
```

```sh
curl -fsSL https://cube-agent.pages.dev/docs/configuration.md
```

`skill_read` reads this skill's local resources, not remote URLs. This skill
contains no bundled documentation. If command output is truncated, retrieve the
needed continuation through `manage_task`; do not assume the missing part is empty.

Check the exact field and applying-changes section before proposing a config edit.
Keep credentials, workspace permissions and MCP connections in the files the guide
specifies. Answer with the relevant documentation link and only the detail needed.
Reading an installation example does not authorize installing or updating Cube.

Online docs can be newer than the installed release. For a discrepancy, establish
the user's version and distinguish documented behavior from observed behavior.
When working on Cube's source, verify the implementation in the checkout as well.
If docs cannot be reached, say so rather than inventing fields or claiming to have
read them.
