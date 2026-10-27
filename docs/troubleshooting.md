# Troubleshooting

Find the actual failure before retrying, changing providers, or discarding evidence.

<a id="provider-errors"></a>

## Provider, Quota & Input Errors

Authentication failures can require replacing a key or logging out/signing in via /gateway. HTTP 429 usually indicates rate limiting or quota; check the actual provider message and account billing. A catalog entry or successful login is not proof that credits remain.

Cube has no automatic fallback_model. Choose another available model/gateway deliberately. Do not repeatedly rerun the same expensive task after a quota failure.

For file-input errors, check endpoint/plan support. A PDF read can become provider file input; xAI ZDR can reject file content. Changing the TUI's expanded transcript or its colors does not change provider token billing or accepted modalities.

<a id="oauth"></a>

## OAuth & Model Discovery

If you closed the browser, reopen the authorization URL still visible in the sign-in view before it expires. If authorization has expired or been revoked, select the provider again after logging out. Do not paste access/refresh tokens into chat.

For missing OAuth models, check the account, selected provider and model catalog; API-key access and subscription access are different. Hidden/internal models do not need to appear in /model. Update Cube if the provider changes its client compatibility requirements.

<a id="mcp-skills"></a>

## MCP & Skill Loading

Open /mcp to read a server's error. Verify command/PATH, cwd, endpoint, required headers and provider authorization; then Restart that server. Use /reload after modifying mcp.json. If tool names collide, configure a different server/tool set rather than expecting a silent override.

For missing skills, inspect /skills for source/path and enabled state. SKILL.md needs valid YAML frontmatter and a name matching its directory. Use the [documented project/global sources](/docs/skills#sources); a new project source directory absent at startup requires restarting Cube. Native refresh has a cooldown, so a newly added skill is not guaranteed to appear immediately. Resolve same-name ambiguity by renaming or disabling the unwanted source. Editing a malformed skill does not require altering Cube's dependencies.

For custom subagents, use the separate [role directories](/docs/subagents#custom-agents) and /reload. A role inside a skill's agents folder is not discovered. For project instructions, use [AGENTS.md locations](/docs/instructions#agents); CLAUDE.md is not automatically loaded by Cube's active snapshot loader.

<a id="jobs"></a>

## Background & Subagent Evidence

Use /tasks or manage_task for command process IDs; use /subagents or manage_subagent for delegated job UUIDs. An accepted/running job does not have a final result yet. Let completion arrive automatically unless you need a specific readiness check or the user asks for progress.

A child failure may still leave a readable private transcript. Read it before asserting that no evidence was collected. After exiting/restarting, historical process rows do not attach to old OS processes, and expired temporary command logs cannot be recovered from a preview alone.

<a id="logs"></a>

## Diagnostics & Safe Reporting

Check ~/.cube/logs/threads for thread-scoped diagnostics, and include the thread ID, Cube version, gateway/model, failing tool and exact error when reporting a bug. Review logs for private source content, identifiers, tokens and headers before sharing them.

Record whether the issue is reproducible after /resume or a new launch. Do not delete ~/.cube as a generic troubleshooting step: it contains credentials, settings, conversations and durable memory.
