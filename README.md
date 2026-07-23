# Agentic Agent

TypeScript LangGraph agent project running on LangGraph Agent Server. The main graph is exposed as `main_agent` and is designed to run locally with LangGraph Studio, MongoDB-backed checkpoints, and a Dockerized Ollama service for local LLM calls.

## Tech Stack

- TypeScript + Node.js ESM
- LangGraph JS for graph orchestration
- LangChain Core message, tool, and model abstractions
- LangGraph Agent Server via `@langchain/langgraph-cli`
- Ollama or Gemini as chat model providers
- Docker Compose for local production-like runtime
- LangSmith Studio for graph UI and traces

## Project Tree

```text
├── src
│   ├───background/
│   ├───config/  
│   ├───conversation/
│   ├───gateway/   
│   ├───guardrail/
│   ├───memory/
│   │   ├───long-term/
│   │   └───short-term/
│   ├───provider/    
│   ├───tools/
│   │   ├───domain/
│   │   └───system/
│   └───workflow/
│       └───main/
│           ├───node/
│           └───prompt/        
├── docker-compose.local.yml         
├── langgraph.json                   
├── package.json
└── tsconfig.json
```

## Graph

`langgraph.json` exposes one graph:

```json
{
  "graphs": {
    "main-agent": "./src/workflow/main/graph.ts:graph"
  }
}
```

The graph entry point is `src/graph/main/graph.ts`.

## Environment

Create `.env` from `.env.exmaple` and fill required values.

Important variables:

```env
LANGSMITH_API_KEY=
LANGSMITH_TRACING=true
LANGSMITH_PROJECT=agentic-agent-dev

LS_MONGODB_URI=mongodb://user:password@host1:27017,host2:27017,host3:27017/agentic-agent?ssl=true&replicaSet=...&authSource=admin

DEFAULT_CHAT_PROVIDER=ollama
DEFAULT_CHAT_MODEL=qwen2.5:7b
OLLAMA_BASE_URL=http://ollama:11434

LLM_PROVIDERS=[{"provider":"ollama","apiKeyEnv":"OLLAMA_BASE_URL","models":["qwen2.5:7b"]},{"provider":"gemini","apiKeyEnv":"GEMINI_API_KEY","models":["gemini-2.5-flash"]}]
```

## Install

Use WSL for Docker-based local runtime.

```bash
npm install
```

## Local Docker Runtime

Run the Agent Server, Postgres, Redis, and Ollama:

```bash
npx @langchain/langgraph-cli up --recreate --wait
```

`langgraph.json` already points to `docker-compose.local.yml`, so the Ollama service is included automatically.

The API runs at:

```text
http://127.0.0.1:8123
```

Open LangGraph Studio:

```text
https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:8123
```

Use graph `main_agent`.

## Ollama Model

After the Docker stack is running, pull the local model into the Ollama container:

```bash
docker exec -it $(docker ps --filter "name=ollama" --format "{{.ID}}") ollama pull qwen2.5:7b
```

Check that `langgraph-api` can reach Ollama:

```bash
docker exec -it $(docker ps --filter "name=langgraph-api" --format "{{.ID}}") \
  node -e "fetch('http://ollama:11434/api/tags').then(r=>r.text()).then(console.log)"
```

## Logs

Run with live logs in the current terminal:

```bash
npx @langchain/langgraph-cli up --recreate
```

Run and wait until services are healthy, then return to the shell:

```bash
npx @langchain/langgraph-cli up --recreate --wait
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

## Rebuild Rules

If the Docker containers are already running and no files changed, use Studio directly:

```text
https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:8123
```

After changing graph logic or TypeScript source, rebuild the API image:

```bash
npx @langchain/langgraph-cli up --recreate --wait
```

After changing `.env`, `langgraph.json`, `docker-compose.local.yml`, `package.json`, or `package-lock.json`, also use:

```bash
npx @langchain/langgraph-cli up --recreate --wait
```

For iterative Docker development with automatic restart, try:

```bash
npx @langchain/langgraph-cli up --watch
```

`--watch` can be slower when the repo is under `/mnt/d`. Keeping the repo inside the WSL filesystem is faster for Docker-heavy work.

## Stop

Get the Docker Compose project name from container labels:

```bash
docker ps --filter "name=agentic-agent" --format '{{.Label "com.docker.compose.project"}}' | sort -u
```

Stop the whole stack while keeping containers, networks, and volumes:

```bash
docker compose --project-name $(docker ps --filter "name=agentic-agent" --format '{{.Label "com.docker.compose.project"}}' | sort -u) stop
```

Remove containers and networks while keeping volumes:

```bash
docker compose --project-name $(docker ps --filter "name=agentic-agent" --format '{{.Label "com.docker.compose.project"}}' | sort -u) down
```

Remove containers, networks, and volumes:

```bash
docker compose --project-name $(docker ps --filter "name=agentic-agent" --format '{{.Label "com.docker.compose.project"}}' | sort -u) down -v
```

`down -v` deletes local Docker volumes, including Postgres data and downloaded Ollama models.

## Development Commands

Type-check:

```bash
npm test
```

Fast local LangGraph dev server:

```bash
npm run dev
```

`npm run dev` uses `langgraphjs dev` on port `2024`. It is useful for quick graph debugging, but the main persistence test path is Docker `up` on port `8123` because that uses the Agent Server Mongo checkpointer backend.
