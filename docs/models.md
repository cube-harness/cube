# Models

Select models and reasoning settings, and inspect actual session usage.

<a id="selection"></a>

## Model Selection & Capabilities

Use /model to search the active gateway's catalog. Capabilities such as tools, vision, reasoning and context limits inform model setup and picker choices. API-key discovery uses provider metadata; OAuth discovery includes models available to that account and hides provider-marked non-visible models.

Catalog capabilities are not proof that an account, plan or endpoint accepts every input. For example, a provider's zero-data-retention plan can reject file content despite a model's advertised modality support.

You can switch models within a conversation. config.yaml is the source of truth for the selected gateway/model. There is no fallback_model: quota failures are surfaced so you can choose another available model or gateway deliberately.

**Cube**

```text
/model
# Direct selection, using an ID available in your catalog:
/model <provider/model-id> --effort high
```

<a id="reasoning"></a>

## Reasoning Effort

Use /effort for the active model's supported options, or /effort high when that level is supported. The general config enum is none, minimal, low, medium, high, xhigh, max and default; providers need not support every value.

Cube maps effort to provider-specific controls. Gemini 3-family requests use thinking levels rather than a numeric thinking budget; older compatible models can use budgets. OpenAI OAuth can supply its own supported-level descriptions rather than Cube's generic API-key labels.

Showing or hiding a reasoning transcript is a TUI preference, not a billing control. Provider-generated reasoning can consume usage independently of whether you expand it with Ctrl+T.

**config.yaml**

```yaml
model_config:
  reasoning_effort: high
```

<a id="status"></a>

## Status & Limits

Run /status (alias /usage) to inspect the active model, capabilities, thread identity, context window and latest cache-read usage. Context occupancy is different from accumulated tokens billed across repeated requests.

OAuth limits depend on what each provider reports. OpenAI can show 5-hour and weekly remaining percentages with reset times. A missing quota/plan field or an xAI free-account reading does not prove unlimited usage. API-key billing remains controlled by the provider.

<a id="related-config"></a>

## config.yaml Reference

Settings related to this guide. Merge examples into your existing file; omitted settings use Cube defaults. See [applying changes](/docs/configuration#defaults).

| Field | Type / range | Default | Behavior |
| --- | --- | --- | --- |
| `model` | Non-empty model ID (optional) | `Not set` | Select an available provider/model with /model. A runnable chat needs both gateway and model; there is no default chat model or fallback_model. |
| `model_config.reasoning_effort` | Optional effort enum | `Not set` | none, minimal, low, medium, high, xhigh, max or default. Availability and mapping depend on the active model/provider; prefer the /effort picker. |
