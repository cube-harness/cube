# Configuration

The complete config.yaml reference, plus the separate files that own credentials and permissions.

<a id="home"></a>

## Home Directory & File Ownership

Cube's default home is ~/.cube. Application updates preserve it. Avoid committing credentials or databases to your project.

| File / directory | Responsibility |
| --- | --- |
| config.yaml | Model/gateway selections and the settings documented below. |
| auth.json | API keys, provider OAuth credentials and MCP OAuth state. |
| permission.json | Workspace trust and workspace-specific Ask/Allow/Deny policies. |
| mcp.json | Global external MCP server connections. |
| SOUL.md / AGENTS.md | Personal style and optional global project guidance. |
| model-catalog.json | Discovered capabilities, grouped by gateway strategy/provider. |
| skills/ / agents/ | User-defined global skills and custom subagent roles. |
| memories/memory.sqlite | Conversations, native child history and context checkpoints. |
| memories/*.md / memories/rollout_summaries/ | Structured durable project memory and evidence. |
| logs/threads/ | Thread-scoped diagnostic/error logs. |
| cache/ | Disposable derived data such as pet frames, retrieval indexes and temporary tool output. |

<a id="defaults"></a>

## Defaults, Overrides & Applying Changes

config.yaml is validated strictly. Omitted supported settings receive Cube defaults; unknown fields, wrong types and invalid ranges are rejected. Do not add removed fallback_model, memory.storage, working_memory, observational-memory, semantic_recall, permissions or fetch settings to this file.

Gateway/model have no built-in value: onboarding must obtain a runnable choice. Auxiliary title/compaction/durable-memory and subagent models default to inherit. The embedding model must be explicit when retrieval is enabled.

Title, compaction and durable memory each accept an optional reasoning_effort. An explicit value overrides the parent effort. When omitted, model: inherit captures the active parent's reasoning options; a separately selected model uses its provider defaults. Use default explicitly to avoid inheriting the parent's effort. SQLite local storage and its database path are fixed internally, not YAML options.

Interactive commands save their own supported settings and apply them immediately. For hand-written startup settings, restart Cube. /reload refreshes instruction/durable-memory snapshots, the custom-agent catalog and MCP configuration, and applies memory.durable.retrieval plus local embedding endpoint edits. It does not hot-apply chat model, reasoning, background scheduling or every other config.yaml field, and it does not rebuild the skill-source directory list.

Examples on feature pages are partial blocks. Merge them into existing YAML mappings instead of duplicating a memory or subagents key. Credentials go in auth.json via /gateway; permissions stay in permission.json and connections in mcp.json.

<a id="all-fields"></a>

## All config.yaml Fields

The table below includes every currently supported leaf field, including optional settings absent from the generated template. Related-guide links explain when and why to change them. Empty parent mappings receive defaults except the optional local gateway endpoint objects.

| Field | Type / range | Default | Behavior | Guide |
| --- | --- | --- | --- | --- |
| `gateway` | Gateway ID (optional) | `Not set` | Select with /gateway. api_key/`<provider>`, oauth/openai\|xai\|anthropic\|google, or local/ollama\|lmstudio. No built-in credential or gateway is selected for you. | [Related guide](/docs/gateways) |
| `model` | Non-empty model ID (optional) | `Not set` | Select an available provider/model with /model. A runnable chat needs both gateway and model; there is no default chat model or fallback_model. | [Related guide](/docs/models) |
| `gateway_options.local/ollama.base_url` | Absolute URL | `http://127.0.0.1:11434` | Ollama server URL. The parent local/ollama object is optional; the adapter uses the default endpoint when omitted. | [Related guide](/docs/gateways) |
| `gateway_options.local/lmstudio.base_url` | Absolute URL | `http://127.0.0.1:1234/v1` | LM Studio OpenAI-compatible server URL, including /v1. The parent local/lmstudio object is optional. | [Related guide](/docs/gateways) |
| `model_config.reasoning_effort` | Optional effort enum | `Not set` | none, minimal, low, medium, high, xhigh, max or default. Availability and mapping depend on the active model/provider; prefer the /effort picker. | [Related guide](/docs/models) |
| `skills.disabled` | Non-empty string[] | `[]` | Disabled SKILL.md paths, or builtin:`<name>` for a built-in skill. /skills writes canonical identifiers; a bare skill name is not a replacement for its path. | [Related guide](/docs/skills) |
| `theme` | Non-empty string | `default` | Syntax-highlighting theme. Use /theme to select a supported installed theme. | [Related guide](/docs/commands) |
| `app_title` | Non-empty string[] | `["workspace", "threadId"]` | Ordered terminal-title fields: model, workspace, threadTitle, threadId, status. Use /title; unknown strings do not create new fields. | [Related guide](/docs/commands) |
| `status_line` | Non-empty string[] | `["workspace", "model"]` | Ordered footer fields: model, workspace, agentMd, threadTitle, threadId, status. Use /statusline. | [Related guide](/docs/commands) |
| `telemetry` | Boolean | `false` | Enable Mastra observability/tracing at startup. This is independent of the local thread error logs. | [Related guide](/docs/configuration) |
| `soul.max_characters` | Integer: 1–1,000,000 | `2000` | SOUL.md length limit. Oversized content fails validation rather than being silently truncated. Keep personality concise; Cube's operating instructions are built in separately. | [Related guide](/docs/instructions) |
| `subagents.concurrency` | Integer: 1–32 | `2` | Maximum simultaneously executing delegated jobs. Extra jobs queue FIFO; waiting approvals still occupy a slot. | [Related guide](/docs/subagents) |
| `subagents.model` | Non-empty model ID or inherit | `inherit` | Shared child-model default. A custom role's model wins; inherit uses the parent model captured for the assignment. | [Related guide](/docs/subagents) |
| `subagents.reasoning_effort` | Optional effort enum | `Not set` | Shared child reasoning default. A custom role can override it; otherwise inherit the parent's setting when no shared value is supplied. | [Related guide](/docs/subagents) |
| `subagents.timeout_ms` | Integer: 0–9,007,199,254,740,991 | `0` | 0 disables the deadline. Positive values include execution and approval/input waits, but not queue time. | [Related guide](/docs/subagents) |
| `background_tasks.enabled` | Boolean | `true` | Enable background command execution. It does not turn every foreground command into a background job. | [Related guide](/docs/background-tasks) |
| `background_tasks.concurrency` | Integer: 1–32 | `2` | Maximum concurrently running background commands; additional commands wait in the queue. | [Related guide](/docs/background-tasks) |
| `background_tasks.timeout_ms` | Integer: 0–600,000 | `300000` | Background command deadline in milliseconds. 0 disables it; execute_command timeout:null disables it for that background command. | [Related guide](/docs/background-tasks) |
| `truncation_policy.execute_command.max_bytes` | Integer: 4–262,144 | `262144` | Maximum command-result preview bytes, not a token budget or the full log-file size limit. | [Related guide](/docs/context) |
| `truncation_policy.execute_command.max_lines` | Integer: 1–2,000 | `200` | Default command preview line limit. A tool's explicit tail can request up to 2,000 lines; missing output can be paged with manage_task. | [Related guide](/docs/context) |
| `memory.generate_title.enabled` | Boolean | `false` | Enable an extra model call to generate a thread title. Otherwise Cube derives it from the first prompt. | [Related guide](/docs/memory-sessions) |
| `memory.generate_title.model` | Non-empty model ID or inherit | `inherit` | Model used only for title generation when enabled. | [Related guide](/docs/memory-sessions) |
| `memory.generate_title.reasoning_effort` | Optional effort enum | `Not set` | Override title-generation reasoning. Omitted: inherit parent options for model: inherit, otherwise use provider defaults. default suppresses parent-effort inheritance. Supported levels depend on the selected model. | [Related guide](/docs/memory-sessions) |
| `memory.generate_title.instructions` | Non-empty string | `Generate a concise title under 80 characters.` | Instructions for the title generator, not the main coding agent. | [Related guide](/docs/memory-sessions) |
| `memory.compaction.model` | Non-empty model ID or inherit | `inherit` | Model used for continuation summaries; an override does not change the chat model. | [Related guide](/docs/context) |
| `memory.compaction.reasoning_effort` | Optional effort enum | `Not set` | Override compact-summary reasoning without changing chat effort. Omitted: inherit parent options for model: inherit, otherwise use provider defaults. default suppresses parent-effort inheritance. | [Related guide](/docs/context) |
| `memory.compaction.manual_min_ratio` | Number: >0 and <1 | `0.30` | Minimum context occupancy for /compact. A safe conversation cut must also exist. This is not the automatic trigger. | [Related guide](/docs/context) |
| `memory.compaction.keep_recent_ratio` | Number: >0 and <1 | `0.20` | Fraction of conversation capacity retained after reserving instruction and summary space. Retention is token-based, not a fixed message count. | [Related guide](/docs/context) |
| `memory.compaction.reserve_tokens` | Positive integer | `16384` | Output/counting reserve used to derive the safe input budget. Not an auto-compaction ratio or a fixed summary length. | [Related guide](/docs/context) |
| `memory.durable.enabled` | Boolean | `true` | Enable background extraction and consolidation of durable project memory. These are separate model calls from compaction. | [Related guide](/docs/memory-sessions) |
| `memory.durable.model` | Non-empty model ID or inherit | `inherit` | Model for memory extraction/consolidation; inherit uses the main model rather than requiring another credential strategy. | [Related guide](/docs/memory-sessions) |
| `memory.durable.reasoning_effort` | Optional effort enum | `Not set` | Override extraction/consolidation reasoning. Omitted: inherit parent options for model: inherit, otherwise use provider defaults. default suppresses parent-effort inheritance. | [Related guide](/docs/memory-sessions) |
| `memory.durable.min_idle_hours` | Finite number: 0–720 | `6` | Minimum source-thread inactivity before memory extraction is eligible. 0 removes the age requirement; other safety/size checks still apply. | [Related guide](/docs/memory-sessions) |
| `memory.durable.retrieval.enabled` | Boolean | `false` | Enable embeddings/hybrid retrieval. BM25 remains the fallback when no usable index/chunks exist or embeddings fail; committed chunks can be searched while other chunks are indexing. | [Related guide](/docs/memory-sessions) |
| `memory.durable.retrieval.model` | Concrete provider/model or null | `null` | Required when retrieval is enabled. Use a supported API-key provider, ollama or lmstudio. OAuth and inherit are not embedding choices. | [Related guide](/docs/memory-sessions) |

<a id="example"></a>

## Complete Default Configuration

This settings example is valid without a gateway/model so onboarding can configure them. Uncomment the optional choices only with values available in your active catalog. It includes all non-optional leaf settings; gateway, model and reasoning_effort overrides are shown as comments.

**config.yaml**

```yaml
# ~/.cube/config.yaml — missing settings use Cube defaults.
# /gateway and /model save these selections; there is no built-in default:
# gateway: api_key/<provider>
# model: <provider>/<model-id>
model_config: {}
# Optional: model_config.reasoning_effort: high
skills:
  disabled: []
gateway_options:
  local/ollama:
    base_url: http://127.0.0.1:11434
  local/lmstudio:
    base_url: http://127.0.0.1:1234/v1
theme: default
app_title: [workspace, threadId]
status_line: [workspace, model]
telemetry: false
soul:
  max_characters: 2000
subagents:
  concurrency: 2
  model: inherit
  # reasoning_effort: medium
  timeout_ms: 0
background_tasks:
  enabled: true
  concurrency: 2
  timeout_ms: 300000
truncation_policy:
  execute_command:
    max_bytes: 262144
    max_lines: 200
memory:
  generate_title:
    enabled: false
    model: inherit
    # reasoning_effort: low
    instructions: Generate a concise title under 80 characters.
  compaction:
    model: inherit
    # reasoning_effort: low
    manual_min_ratio: 0.30
    keep_recent_ratio: 0.20
    reserve_tokens: 16384
  durable:
    enabled: true
    model: inherit
    # reasoning_effort: low
    min_idle_hours: 6
    retrieval:
      enabled: false
      model: null
```
