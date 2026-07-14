# Agent Server API Spec

Date: 2026-07-10
Scope: LangGraph Agent Server API for the current TypeScript agent project.

## Purpose

This document describes how a backend or frontend should call a LangGraph Agent Server. It covers the main REST endpoints, request bodies, common flows, and the boundary between Agent Server deployment and a custom backend.

Agent Server API is not OpenAI. The API source is an OpenAPI document from LangChain/LangSmith docs. OpenAPI is a standard format for describing REST APIs.

## Hosting Model

Agent Server API exists when the project is run by a LangGraph Agent Server runtime:

- Local development: `npx @langchain/langgraph-cli dev`
- Local Docker validation: `npx @langchain/langgraph-cli up`
- LangSmith / LangGraph Platform deployment
- Self-hosted Agent Server image on a platform such as Railway, Fly, Render, ECS, or Kubernetes

If the graph is imported into a custom Express, NestJS, or Next.js backend and called with `graph.invoke()` or `graph.stream()`, then there is no built-in Agent Server API. In that setup, the API is whatever the backend exposes.

## Running Agent Server Runtime

Use Docker runtime when you want to test the same Agent Server API shape that Studio, backend clients, and deployments use.

Run from WSL at the project root:

```bash
npx @langchain/langgraph-cli up --recreate --wait
```

This starts the Agent Server stack from `langgraph.json` and `docker-compose.local.yml`. The stack includes:

```text
langgraph-api
langgraph-postgres
langgraph-redis
ollama
```

When the command finishes successfully, open Studio with the Agent Server base URL printed by the CLI:

```text
https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:8123
```

The local API base URL is:

```text
http://127.0.0.1:8123
```

Use graph:

```text
main_agent
```

Use live logs while developing:

```bash
npx @langchain/langgraph-cli up --recreate
```

Use detached health-check style startup:

```bash
npx @langchain/langgraph-cli up --recreate --wait
```

If the containers are already running and code did not change, do not rerun `up`. Open Studio again and reuse the existing Agent Server.

Rebuild the API image after changing:

```text
src/**
langgraph.json
docker-compose.local.yml
package.json
package-lock.json
.env
```

For iterative development with automatic restart:

```bash
npx @langchain/langgraph-cli up --watch
```

Rebuild rules:

```text
No code or config changed:
  Reuse the running containers and open Studio again.

Graph logic changed under src/**:
  Run npx @langchain/langgraph-cli up --recreate --wait.

Runtime config changed:
  Run npx @langchain/langgraph-cli up --recreate --wait.
```

Runtime config includes:

```text
langgraph.json
docker-compose.local.yml
package.json
package-lock.json
.env
```

Show running containers:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

Follow Agent Server logs:

```bash
docker logs -f $(docker ps --filter "name=langgraph-api" --format "{{.ID}}")
```

Follow Ollama logs:

```bash
docker logs -f $(docker ps --filter "name=ollama" --format "{{.ID}}")
```

Stop the stack while keeping containers, networks, and volumes:

```bash
docker compose --project-name $(docker ps --filter "name=agentic-agent" --format '{{.Label "com.docker.compose.project"}}' | sort -u) stop
```

Use `stop` when you want to pause the stack and keep all local data.

Remove containers and networks while keeping volumes:

```bash
docker compose --project-name $(docker ps --filter "name=agentic-agent" --format '{{.Label "com.docker.compose.project"}}' | sort -u) down
```

Use `down` when you want a clean container restart but still keep Agent Server Postgres data.

Remove containers, networks, and volumes:

```bash
docker compose --project-name $(docker ps --filter "name=agentic-agent" --format '{{.Label "com.docker.compose.project"}}' | sort -u) down -v
```

Use `down -v` only when you intentionally want to reset local runtime state. It deletes local Docker volumes, including Agent Server Postgres data and any checkpoint/thread/run history stored there.

## Base URL And Auth

Local development:

```text
http://localhost:2024
```

Production or self-host:

```text
https://your-agent-server-domain.com
```

Headers:

```http
Content-Type: application/json
X-Api-Key: <LANGSMITH_API_KEY>
```

`X-Api-Key` is required when the deployment is configured with authentication. Local dev may run without it.

## Core Concepts

`assistant` is a configured graph instance. It points to a `graph_id` from `langgraph.json` and can carry static `context`, `config`, and `metadata`.

`thread` is a durable conversation or workflow state. Use one thread per chat conversation, task session, or long-running workflow.

`run` is one graph execution. A run can be stateful on a thread, or stateless without an existing thread.

`store` is the long-term memory / key-value store. It supports namespace paths, keys, values, search, and optional indexing.

## System API

Health check:

```http
GET /ok
```

Server information:

```http
GET /info
```

Local API docs:

```http
GET /docs
```

Metrics:

```http
GET /metrics
```

Use `/ok` for deployment health checks. Use `/info` for verifying the server runtime and graph availability.

## Assistants API

### Create Assistant

```http
POST /assistants
```

Body:

```json
{
  "graph_id": "main_agent",
  "name": "Dev vi-VN",
  "description": "Assistant configured for development user context.",
  "context": {
    "userId": "dev",
    "userRole": "admin",
    "timeZone": "Asia/Ho_Chi_Minh",
    "locale": "vi-VN"
  },
  "config": {
    "tags": ["dev"],
    "recursion_limit": 25,
    "configurable": {}
  },
  "metadata": {
    "tenantId": "dev",
    "environment": "local"
  },
  "if_exists": "do_nothing"
}
```

Required:

- `graph_id`

Common fields:

- `context`: static runtime context passed to graph nodes and tools.
- `config`: graph runnable config.
- `metadata`: searchable metadata for management.
- `if_exists`: `raise` or `do_nothing`.

### Search Assistants

```http
POST /assistants/search
```

Body:

```json
{
  "graph_id": "main_agent",
  "name": "Dev",
  "metadata": {
    "tenantId": "dev"
  },
  "limit": 10,
  "offset": 0,
  "sort_by": "created_at",
  "sort_order": "desc",
  "select": [
    "assistant_id",
    "graph_id",
    "name",
    "context",
    "metadata",
    "created_at",
    "updated_at"
  ]
}
```

### Get Assistant

```http
GET /assistants/{assistant_id}
```

Use this to verify `context`, `config`, and `metadata`.

### Patch Assistant

```http
PATCH /assistants/{assistant_id}
```

Body:

```json
{
  "name": "Dev vi-VN",
  "description": "Updated assistant description.",
  "context": {
    "userId": "dev",
    "userRole": "admin",
    "timeZone": "Asia/Ho_Chi_Minh",
    "locale": "vi-VN"
  },
  "metadata": {
    "tenantId": "dev"
  }
}
```

### Delete Assistant

```http
DELETE /assistants/{assistant_id}
```

### Inspect Assistant Graph

```http
GET /assistants/{assistant_id}/schemas
GET /assistants/{assistant_id}/graph
GET /assistants/{assistant_id}/subgraphs
GET /assistants/{assistant_id}/subgraphs/{namespace}
```

Use these for debugging graph schema, graph structure, and subgraph structure.

### Assistant Versions

```http
POST /assistants/{assistant_id}/versions
POST /assistants/{assistant_id}/latest
```

Use these when managing assistant version history.

## Threads API

### Create Thread

```http
POST /threads
```

Body:

```json
{
  "metadata": {
    "userId": "dev",
    "tenantId": "dev",
    "title": "Development chat"
  },
  "if_exists": "do_nothing",
  "ttl": {
    "strategy": "keep_latest",
    "ttl": 43200
  }
}
```

Fields:

- `thread_id`: optional UUID. If omitted, the server generates one.
- `metadata`: searchable metadata.
- `ttl.strategy`: `delete` or `keep_latest`.
- `ttl.ttl`: minutes until cleanup.
- `supersteps`: optional initial state setup. Avoid this unless restoring/importing state.

### Search Threads

```http
POST /threads/search
```

Body:

```json
{
  "metadata": {
    "userId": "dev"
  },
  "status": "idle",
  "limit": 20,
  "offset": 0,
  "sort_by": "updated_at",
  "sort_order": "desc",
  "select": [
    "thread_id",
    "created_at",
    "updated_at",
    "metadata",
    "status",
    "values"
  ]
}
```

Supported `status` values:

- `idle`
- `busy`
- `interrupted`
- `error`

### Count Threads

```http
POST /threads/count
```

Body:

```json
{
  "metadata": {
    "userId": "dev"
  },
  "status": "idle"
}
```

### Get Thread

```http
GET /threads/{thread_id}
```

### Patch Thread

```http
PATCH /threads/{thread_id}
```

Body:

```json
{
  "metadata": {
    "title": "Updated chat title"
  },
  "ttl": {
    "strategy": "keep_latest",
    "ttl": 43200
  }
}
```

### Delete Thread

```http
DELETE /threads/{thread_id}
```

### Copy Thread

```http
POST /threads/{thread_id}/copy
```

Use this for branching or debugging an existing conversation.

### Prune Threads

```http
POST /threads/prune
```

Use this for cleanup. Do not expose this directly to frontend users.

## Thread Runs API

Thread runs are the normal chat path for applications that need durable conversation state.

### Stream A Thread Run

```http
POST /threads/{thread_id}/runs/stream
```

Body:

```json
{
  "assistant_id": "main_agent",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "Bây giờ là mấy giờ?"
      }
    ]
  },
  "context": {
    "userId": "dev",
    "userRole": "admin",
    "timeZone": "Asia/Ho_Chi_Minh",
    "locale": "vi-VN"
  },
  "metadata": {
    "source": "web"
  },
  "config": {
    "tags": ["chat"],
    "recursion_limit": 25,
    "configurable": {}
  },
  "stream_mode": "messages",
  "stream_subgraphs": false,
  "stream_resumable": false,
  "multitask_strategy": "enqueue",
  "durability": "async",
  "on_disconnect": "continue"
}
```

Required:

- `assistant_id`

Important fields:

- `input`: graph input. For this repo, use `{ "messages": [...] }`.
- `context`: per-run context. This can override or supplement assistant context.
- `stream_mode`: `messages`, `messages-tuple`, `updates`, `values`, `events`, `debug`, `tasks`, `checkpoints`, or `custom`.
- `multitask_strategy`: `reject`, `rollback`, `interrupt`, or `enqueue`.
- `durability`: `sync`, `async`, or `exit`.
- `on_disconnect`: `cancel` or `continue`.

Recommended for chat UI:

```json
{
  "stream_mode": "messages",
  "multitask_strategy": "enqueue",
  "on_disconnect": "continue"
}
```

### Wait For A Thread Run

```http
POST /threads/{thread_id}/runs/wait
```

Use when the caller wants one final response instead of streaming.

Body:

```json
{
  "assistant_id": "main_agent",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "Tóm tắt cuộc trò chuyện này"
      }
    ]
  },
  "context": {
    "userId": "dev",
    "locale": "vi-VN",
    "timeZone": "Asia/Ho_Chi_Minh"
  },
  "stream_mode": "updates"
}
```

### Create Background Thread Run

```http
POST /threads/{thread_id}/runs
```

Body:

```json
{
  "assistant_id": "main_agent",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "Chạy tác vụ nền này"
      }
    ]
  },
  "metadata": {
    "jobType": "background"
  },
  "webhook": "https://your-backend.com/webhooks/agent-run-completed",
  "stream_mode": "updates"
}
```

Use this when the caller does not need to hold an open stream.

### List Runs

```http
GET /threads/{thread_id}/runs
```

### Get Run

```http
GET /threads/{thread_id}/runs/{run_id}
```

### Join Run

```http
GET /threads/{thread_id}/runs/{run_id}/join
```

### Join Run Stream

```http
GET /threads/{thread_id}/runs/{run_id}/stream
```

### Cancel Run

```http
POST /threads/{thread_id}/runs/{run_id}/cancel
```

### Delete Run

```http
DELETE /threads/{thread_id}/runs/{run_id}
```

## Stateless Runs API

Use stateless runs for one-shot calls, tests, and tasks that do not need an existing thread.

### Stream Stateless Run

```http
POST /runs/stream
```

Body:

```json
{
  "assistant_id": "main_agent",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "Xin chào"
      }
    ]
  },
  "context": {
    "userId": "dev",
    "userRole": "admin",
    "timeZone": "Asia/Ho_Chi_Minh",
    "locale": "vi-VN"
  },
  "stream_mode": "messages",
  "on_completion": "delete",
  "on_disconnect": "continue"
}
```

`on_completion`:

- `delete`: delete the temporary thread after completion.
- `keep`: keep the temporary thread after completion.

### Wait Stateless Run

```http
POST /runs/wait
```

Body is the same shape as `/runs/stream`.

### Background Stateless Run

```http
POST /runs
```

Body:

```json
{
  "assistant_id": "main_agent",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "Chạy tác vụ một lần"
      }
    ]
  },
  "webhook": "https://your-backend.com/webhooks/agent-run-completed",
  "on_completion": "delete"
}
```

### Batch Stateless Runs

```http
POST /runs/batch
```

Use for multiple independent runs. Prefer backend-only usage.

### Cancel Runs

```http
POST /runs/cancel
```

Cancel by status:

```json
{
  "status": "running"
}
```

Cancel specific runs:

```json
{
  "thread_id": "00000000-0000-0000-0000-000000000000",
  "run_ids": [
    "00000000-0000-0000-0000-000000000000"
  ]
}
```

`status` can be:

- `pending`
- `running`
- `all`

## State And History API

These endpoints are for debugging, replay, interrupts, and advanced state management. Do not expose them directly to frontend users.

### Get Current Thread State

```http
GET /threads/{thread_id}/state
```

### Update Thread State

```http
POST /threads/{thread_id}/state
```

Body:

```json
{
  "values": {
    "messages": [
      {
        "role": "user",
        "content": "Injected message"
      }
    ]
  },
  "as_node": "agent"
}
```

Fields:

- `values`: state values to update.
- `checkpoint`: optional checkpoint config.
- `as_node`: update as if a specific node executed.

### Get State At Checkpoint

```http
GET /threads/{thread_id}/state/{checkpoint_id}
POST /threads/{thread_id}/state/checkpoint
```

Body for `POST`:

```json
{
  "checkpoint": {
    "checkpoint_id": "00000000-0000-0000-0000-000000000000"
  }
}
```

### Get Thread History

```http
GET /threads/{thread_id}/history
POST /threads/{thread_id}/history
```

Body for `POST`:

```json
{
  "limit": 10,
  "metadata": {}
}
```

## Store API

Use Store API for long-term memory and durable key-value data.

### Put Store Item

```http
PUT /store/items
```

Body:

```json
{
  "namespace": ["memories", "dev"],
  "key": "profile-name",
  "value": {
    "kind": "semantic",
    "content": "Tên người dùng là Phúc"
  },
  "index": ["content"],
  "ttl": null
}
```

Required:

- `namespace`
- `key`
- `value`

`index`:

- `null`: use store defaults.
- `false`: disable indexing.
- `["content"]`: index selected fields.

### Get Store Item

```http
GET /store/items?namespace=memories&namespace=dev&key=profile-name
```

### Search Store Items

```http
POST /store/items/search
```

Body:

```json
{
  "namespace_prefix": ["memories", "dev"],
  "query": "Tên người dùng là gì?",
  "filter": {
    "kind": "semantic"
  },
  "limit": 5,
  "offset": 0,
  "refresh_ttl": null
}
```

If `query` is omitted or null, the endpoint lists items by last updated time. If `query` is present, it performs natural language search.

### List Store Namespaces

```http
POST /store/namespaces
```

Body:

```json
{
  "prefix": ["memories"],
  "suffix": ["dev"],
  "max_depth": 2,
  "limit": 100,
  "offset": 0
}
```

### Delete Store Item

```http
DELETE /store/items
```

Body:

```json
{
  "namespace": ["memories", "dev"],
  "key": "profile-name"
}
```

## Crons API

Use crons for scheduled agent runs.

### Create Stateless Cron

```http
POST /runs/crons
```

Body:

```json
{
  "assistant_id": "main_agent",
  "schedule": "0 9 * * *",
  "timezone": "Asia/Ho_Chi_Minh",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "Nhắc tôi review task hôm nay"
      }
    ]
  },
  "context": {
    "userId": "dev",
    "locale": "vi-VN",
    "timeZone": "Asia/Ho_Chi_Minh"
  },
  "metadata": {
    "jobType": "daily-reminder"
  },
  "enabled": true,
  "stream_mode": "updates",
  "on_run_completed": "delete",
  "durability": "async"
}
```

This creates a new thread for each execution.

### Create Thread Cron

```http
POST /threads/{thread_id}/runs/crons
```

Body:

```json
{
  "assistant_id": "main_agent",
  "schedule": "0 9 * * *",
  "timezone": "Asia/Ho_Chi_Minh",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "Cập nhật thread này theo lịch"
      }
    ]
  },
  "context": {
    "userId": "dev",
    "locale": "vi-VN",
    "timeZone": "Asia/Ho_Chi_Minh"
  },
  "enabled": true,
  "multitask_strategy": "enqueue",
  "stream_mode": "updates"
}
```

This runs repeatedly on the same thread.

### Manage Crons

```http
GET    /runs/crons/{cron_id}
PATCH  /runs/crons/{cron_id}
DELETE /runs/crons/{cron_id}
POST   /runs/crons/search
POST   /runs/crons/count
```

Patch body:

```json
{
  "enabled": false,
  "schedule": "0 10 * * *",
  "timezone": "Asia/Ho_Chi_Minh"
}
```

## Streaming Protocol V2

Advanced protocol endpoints:

```http
POST /threads/{thread_id}/commands
POST /threads/{thread_id}/stream/events
GET  /threads/{thread_id}/stream
```

For this project, prefer SDK methods or `/runs/stream` first. Use protocol v2 only when building a custom event-driven client.

## MCP API

```http
GET    /mcp/
POST   /mcp/
DELETE /mcp/
```

These endpoints are for MCP integration. They are not required for the current basic chat and memory flow.

## A2A API

```http
POST /a2a/{assistant_id}
```

This endpoint is for Agent-to-Agent JSON-RPC. It is not required for the current basic chat and memory flow.

## Recommended Backend Flow

Create or reuse assistant:

```text
POST /assistants/search
POST /assistants
```

Create a new conversation:

```text
POST /threads
```

Send a chat message:

```text
POST /threads/{thread_id}/runs/stream
```

Load conversation list:

```text
POST /threads/search
```

Read or write memory directly only when backend needs explicit control:

```text
POST /store/items/search
PUT /store/items
DELETE /store/items
```

## Frontend Boundary

Do not expose broad Agent Server API access directly to an untrusted frontend.

Preferred production shape:

```text
Frontend -> Application Backend -> Agent Server
```

The application backend should own:

- user authentication
- tenant isolation
- `userId`
- `userRole`
- `locale`
- `timeZone`
- thread ownership
- rate limit
- audit logging
- permission checks

The frontend should normally call app-specific endpoints:

```http
POST /api/chat/threads
POST /api/chat/threads/{threadId}/messages
GET  /api/chat/threads
```

The backend maps those endpoints to Agent Server API.

## JavaScript SDK Example

```ts
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({
  apiUrl: "https://your-agent-server-domain.com",
  apiKey: process.env.LANGSMITH_API_KEY,
});

const thread = await client.threads.create({
  metadata: {
    userId: "dev",
  },
});

const stream = client.runs.stream(thread.thread_id, "main_agent", {
  input: {
    messages: [
      {
        role: "user",
        content: "Xin chào",
      },
    ],
  },
  context: {
    userId: "dev",
    userRole: "admin",
    timeZone: "Asia/Ho_Chi_Minh",
    locale: "vi-VN",
  },
  streamMode: "messages",
});

for await (const chunk of stream) {
  console.log(chunk);
}
```

## REST Example

```bash
curl --request POST \
  --url "https://your-agent-server-domain.com/threads/{thread_id}/runs/stream" \
  --header "Content-Type: application/json" \
  --header "X-Api-Key: <LANGSMITH_API_KEY>" \
  --data '{
    "assistant_id": "main_agent",
    "input": {
      "messages": [
        {
          "role": "user",
          "content": "Xin chào"
        }
      ]
    },
    "context": {
      "userId": "dev",
      "userRole": "admin",
      "timeZone": "Asia/Ho_Chi_Minh",
      "locale": "vi-VN"
    },
    "stream_mode": "messages"
  }'
```

## Endpoint Priority For This Project

Implement or wrap these first:

```text
POST /assistants/search
POST /assistants
POST /threads
POST /threads/search
POST /threads/{thread_id}/runs/stream
POST /threads/{thread_id}/runs/wait
POST /store/items/search
PUT  /store/items
GET  /ok
GET  /info
```

Defer these until needed:

```text
Thread state/history mutation
Crons
MCP
A2A
Streaming protocol v2
Assistant versions
```
