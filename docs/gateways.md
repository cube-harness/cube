# Gateways

Use API credentials, a provider OAuth session, or a local model server.

<a id="select"></a>

## Choose or Switch a Gateway

Run /gateway and select a strategy and provider. It saves the chosen gateway and a usable model to config.yaml. /model is scoped to the selected strategy/provider's available catalog, not an unrestricted list of every provider.

Switching strategies does not delete credentials for the other strategies. Do not commit auth.json or share tokens, even when they belong to a personal subscription.

**Cube**

```text
/gateway
/model
/status
```

<a id="api-key"></a>

## API Key

Supported provider IDs are google, openai, anthropic, xai, deepseek, moonshotai, openrouter, mistral, nvidia, zai, zai-coding-plan, alibaba, alibaba-coding-plan, huggingface, and groq. Their gateway IDs use api_key/`<provider>`.

You can save keys for several providers at once. Their catalog cache entries remain separate; /model currently lists the selected API-key provider, not a merged list of every saved key. Use /gateway to switch providers. Cube passes saved credentials to the model gateway at runtime; you do not need to export provider keys in .env for normal use.

A saved key is not proof of remaining credits or model access. An actual model request can still return authentication, quota, billing, or rate-limit errors. Ctrl+D on a provider removes its credential and corresponding catalog entries without clearing other strategies.

<a id="oauth"></a>

## OAuth

OAuth providers are OpenAI, xAI (Grok Build), Anthropic, and Google (Antigravity). Select an unconfigured provider to start its browser sign-in flow. Cube opens the authorization URL and leaves it visible in the TUI so you can reopen it if you close the browser.

A configured provider uses the saved account when selected; it does not force another login. To switch accounts, select it in /gateway, use Ctrl+D to log out, then sign in again. Expired credentials are refreshed when the provider flow supports refresh; revoked credentials may require another login.

OAuth model availability and usage data are provider/account-dependent. A subscription is not the same as API billing, and a supported login does not guarantee access to every model. Read the risk notice shown for applicable providers: unofficial subscription integrations may be restricted by the provider.

<a id="local"></a>

## Local: Ollama & LM Studio

Start Ollama or LM Studio's model server before selecting Local in /gateway. Cube uses the server's discovered models; it does not download or start models for you. The local server must expose a compatible API.

Adjust base_url only when your server uses a different host or port. Keep /v1 on the LM Studio endpoint. A reachable remote endpoint is still a server connection, not a guarantee that data stays on this computer.

**config.yaml · merge this block into your existing file**

```yaml
gateway_options:
  local/ollama:
    base_url: http://127.0.0.1:11434
  local/lmstudio:
    base_url: http://127.0.0.1:1234/v1
```

<a id="related-config"></a>

## config.yaml Reference

Settings related to this guide. Merge examples into your existing file; omitted settings use Cube defaults. See [applying changes](/docs/configuration#defaults).

| Field | Type / range | Default | Behavior |
| --- | --- | --- | --- |
| `gateway` | Gateway ID (optional) | `Not set` | Select with /gateway. api_key/`<provider>`, oauth/openai\|xai\|anthropic\|google, or local/ollama\|lmstudio. No built-in credential or gateway is selected for you. |
| `gateway_options.local/ollama.base_url` | Absolute URL | `http://127.0.0.1:11434` | Ollama server URL. The parent local/ollama object is optional; the adapter uses the default endpoint when omitted. |
| `gateway_options.local/lmstudio.base_url` | Absolute URL | `http://127.0.0.1:1234/v1` | LM Studio OpenAI-compatible server URL, including /v1. The parent local/lmstudio object is optional. |
