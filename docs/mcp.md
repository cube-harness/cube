# MCP

Connect external tools over stdio or HTTP without exposing Cube as an MCP server.

<a id="configuration"></a>

## Server Configuration

MCP connections are global and configured in ~/.cube/mcp.json with the conventional mcpServers object. Cube is a client for tools; this is not a project-local MCP server configuration or a feature that exposes Cube's own tools to other applications.

Use command/args/env for stdio servers, or url/headers for HTTP servers. Preserve provider-supplied configuration formats, replacing example paths and credentials with your own values. For stdio, install the server's required executable and choose an explicit cwd when its files are workspace-specific.

**mcp.json · replace endpoint, token and local script**

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "node",
      "args": ["/absolute/path/to/your-mcp-server.mjs"],
      "env": {},
      "cwd": "/absolute/path/to/server-project"
    },
    "remote-tools": {
      "url": "https://your-server.example/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" },
      "timeout": 60000,
      "connectTimeout": 3000,
      "disabled": false
    }
  }
}
```

<a id="server-fields"></a>

## MCP Fields

These fields belong to mcp.json, not config.yaml. HTTP connections support native streamable HTTP and SSE fallback. A malformed server entry is isolated from the other connections.

| Field | Usage / default |
| --- | --- |
| `mcpServers.<name>` | An independently named server configuration. |
| command / args / env / cwd | Stdio executable, arguments (default []), string environment map (default {}), optional working directory. |
| url / headers | HTTP(S) endpoint and string header map (default {}). |
| type | Optional stdio; HTTP accepts http, streamable-http, streamableHttp or sse. |
| disabled | Boolean; defaults to false. |
| timeout | Positive request/discovery timeout in ms; defaults to 60000. |
| connectTimeout | Positive HTTP connection timeout in ms; defaults to 3000. |
| oauth.client_id / oauth.client_secret | Optional pre-registered HTTP OAuth client; client_id required in this block, client_secret optional. |

<a id="authentication"></a>

## Authentication

Static API tokens use the provider's headers or URL configuration. Do not publish mcp.json when it contains credentials. For OAuth-capable servers, /mcp offers Login when authorization is needed; Cube drives the browser callback and saves OAuth state in auth.json under mcp, scoped to the server and URL.

Servers supporting dynamic client registration do not need a hand-written client_id. A server requiring a pre-registered client can use the oauth block below. Do not combine it with a static Authorization header. A provider token-only integration is not automatically a browser OAuth flow.

**mcp.json · registered client example**

```json
{
  "mcpServers": {
    "registered-tools": {
      "url": "https://your-server.example/mcp",
      "oauth": { "client_id": "YOUR_CLIENT_ID" }
    }
  }
}
```

<a id="tools-restart"></a>

## Tools, Reload & Restart

Run /reload after editing mcp.json, then /mcp to inspect each connection, its tools and any error. Connection failures appear in the MCP picker rather than creating a success message or preventing unrelated servers from being inspected.

Within a server's details you can Enable/Disable, Restart, inspect Tools, Login or Logout when applicable. Reload adopts configuration changes; Restart explicitly reconnects that server. It is not necessary to restart every unchanged server for each /reload.

Cube exposes the original tool names advertised by each server, without adding a server-name prefix. A provider's own prefix remains part of that name. Duplicate names are rejected rather than silently overriding another server or a Cube/subagent tool. MCP tools still pass through workspace tool approval policies.
