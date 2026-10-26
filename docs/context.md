# Context

Budget what the model sees without confusing compaction with transcript deletion.

<a id="window"></a>

## Context Window & Automatic Compaction

/status reports context usage against the active model's catalog limits. Cube assembles system instructions, instruction/memory snapshots, conversation history, signals and tool definitions for each request. A provider's measured request usage and Cube's projected token estimate can differ.

Automatic compaction derives a safe input capacity from the model limits and reserved output space rather than using a fixed auto_compact_ratio. With context C, input limit I (when known), reserve R = max(reserve_tokens, requested output), safe input is min(I, C − R). For example, C=262144 and R=16384 gives at most 245760 input tokens when I does not lower it.

Before a model request exceeds the safe budget, Cube can block further generation to summarize older conversation content and continue with a smaller request. It does not wait for the provider to accept an already oversized prompt. Unknown media costs/catalog limits can prevent exact estimates; a file's base64 character count is not a reliable billing-token count.

<a id="truncation"></a>

## Tool-output Truncation

truncation_policy limits execute_command previews before they become large tool results. max_bytes is bytes, max_lines is lines; neither means tokens. The default preview is capped at 262144 bytes and 200 lines.

The complete captured command output can be paged through manage_task while its runtime log exists. This preview policy does not configure read_file limits, delete the original command output, or change the transcript display's expand/collapse behavior.

**config.yaml**

```yaml
truncation_policy:
  execute_command:
    max_bytes: 262144
    max_lines: 200
```

<a id="pruning"></a>

## Tool-output Pruning

Pruning replaces eligible older tool-result bodies in the model-visible projection while keeping tool-call/result structure valid. It is separate from summarization and does not make an extra summary-model call.

The current selector follows OpenCode-style protection: preserve recent user-turn boundaries and roughly the latest 40K estimated tool-output tokens, and only prune when the removable output exceeds 20K. Protected tools are excluded. These are built-in selection rules, not config.yaml fields.

The full saved transcript remains in SQLite for the UI and evidence retrieval. A pruned request is not proof that those old messages were physically deleted.

<a id="compaction"></a>

## Manual Compaction & Retained History

/compact requires at least manual_min_ratio occupancy (default 0.30) and an eligible safe cut. Low occupancy, insufficient history or unsafe tool boundaries produce a notice instead of wasting a summary call. keep_recent_ratio controls the retained recent token capacity, not a fixed number of messages.

The summary is a continuation context block, not a new user task. It preserves relevant decisions, constraints, evidence, pending work and next actions. Summary output is bounded by the derived reserve and the summarizer's output limit; reserve_tokens is not a mandatory summary length.

Compaction writes a context checkpoint and changes the request projection. It does not erase the full TUI transcript. Resume and fork preserve the corresponding continuation state and tool-call pairing.

**config.yaml**

```yaml
memory:
  compaction:
    model: inherit
    # reasoning_effort: low
    manual_min_ratio: 0.30
    keep_recent_ratio: 0.20
    reserve_tokens: 16384
```

<a id="related-config"></a>

## config.yaml Reference

Settings related to this guide. Merge examples into your existing file; omitted settings use Cube defaults. See [applying changes](/docs/configuration#defaults).

| Field | Type / range | Default | Behavior |
| --- | --- | --- | --- |
| `truncation_policy.execute_command.max_bytes` | Integer: 4–262,144 | `262144` | Maximum command-result preview bytes, not a token budget or the full log-file size limit. |
| `truncation_policy.execute_command.max_lines` | Integer: 1–2,000 | `200` | Default command preview line limit. A tool's explicit tail can request up to 2,000 lines; missing output can be paged with manage_task. |
| `memory.compaction.model` | Non-empty model ID or inherit | `inherit` | Model used for continuation summaries; an override does not change the chat model. |
| `memory.compaction.reasoning_effort` | Optional effort enum | `Not set` | Override compact-summary reasoning. Omitted: inherit parent reasoning for model: inherit, otherwise use provider defaults. default suppresses parent-effort inheritance. |
| `memory.compaction.manual_min_ratio` | Number: >0 and <1 | `0.30` | Minimum context occupancy for /compact. A safe conversation cut must also exist. This is not the automatic trigger. |
| `memory.compaction.keep_recent_ratio` | Number: >0 and <1 | `0.20` | Fraction of conversation capacity retained after reserving instruction and summary space. Retention is token-based, not a fixed message count. |
| `memory.compaction.reserve_tokens` | Positive integer | `16384` | Output/counting reserve used to derive the safe input budget. Not an auto-compaction ratio or a fixed summary length. |
