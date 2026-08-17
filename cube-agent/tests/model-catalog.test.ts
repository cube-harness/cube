import assert from "node:assert/strict";
import test from "node:test";
import { createModelCatalog } from "../src/model-catalog.js";

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const requestUrl = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : String(input);

test("requests only providers with configured credentials", async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    urls.push(url);

    if (url === "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000") {
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "google-key");
      return jsonResponse({
        models: [
          {
            name: "models/gemini-3.6-flash",
            supportedGenerationMethods: ["generateContent"],
            thinking: true,
          },
          {
            name: "models/gemini-embedding-001",
            supportedGenerationMethods: ["embedContent"],
            thinking: false,
          },
        ],
      });
    }

    if (url === "https://openrouter.ai/api/v1/models") {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer openrouter-key",
      );
      return jsonResponse({
        data: [
          {
            id: "openai/gpt-5.1",
            supported_parameters: ["tools", "reasoning"],
          },
          {
            id: "openrouter/free",
            supported_parameters: ["tools"],
          },
        ],
      });
    }

    if (url === "http://127.0.0.1:11434/api/tags") {
      return jsonResponse({ models: [{ name: "qwen2.5:7b" }] });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };
  const catalog = createModelCatalog({
    ollamaBaseUrl: "http://127.0.0.1:11434/api/",
    env: {
      GOOGLE_API_KEY: " google-key ",
      OPENAI_API_KEY: "   ",
      OPENROUTER_API_KEY: "openrouter-key",
    },
    fetcher,
  });

  const result = await catalog.list();

  assert.deepEqual(urls.sort(), [
    "http://127.0.0.1:11434/api/tags",
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    "https://openrouter.ai/api/v1/models",
  ]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.models, [
    {
      id: "google/gemini-3.6-flash",
      provider: "google",
      config: {
        reasoningEffort: { values: ["minimal", "low", "medium", "high"] },
      },
    },
    {
      id: "ollama/qwen2.5:7b",
      provider: "ollama",
      config: {},
    },
    {
      id: "openrouter/openai/gpt-5.1",
      provider: "openrouter",
      config: {
        reasoningEffort: { values: ["low", "medium", "high"] },
      },
    },
    {
      id: "openrouter/openrouter/free",
      provider: "openrouter",
      config: {},
    },
  ]);
});

test("does not request any cloud catalog without a cloud API key", async () => {
  const urls: string[] = [];
  const catalog = createModelCatalog({
    ollamaBaseUrl: "http://ollama.test/api",
    env: {},
    fetcher: async (input) => {
      const url = requestUrl(input);
      urls.push(url);
      if (url === "http://ollama.test/api/tags") {
        return jsonResponse({ models: [{ name: "local" }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const result = await catalog.list();

  assert.deepEqual(urls, ["http://ollama.test/api/tags"]);
  assert.deepEqual(result.models.map(({ id }) => id), ["ollama/local"]);
  assert.deepEqual(result.warnings, []);
});

test("normalizes direct OpenAI and Anthropic model responses", async () => {
  const catalog = createModelCatalog({
    ollamaBaseUrl: "http://ollama.test/api",
    env: {
      OPENAI_API_KEY: "openai-key",
      ANTHROPIC_API_KEY: "anthropic-key",
    },
    fetcher: async (input, init) => {
      const url = requestUrl(input);
      const headers = new Headers(init?.headers);

      if (url === "https://api.openai.com/v1/models") {
        assert.equal(headers.get("authorization"), "Bearer openai-key");
        return jsonResponse({
          data: [
            { id: "gpt-5.1", object: "model", owned_by: "openai" },
            { id: "text-embedding-3-small", object: "model", owned_by: "openai" },
          ],
        });
      }

      if (url === "https://api.anthropic.com/v1/models?limit=1000") {
        assert.equal(headers.get("x-api-key"), "anthropic-key");
        assert.equal(headers.get("anthropic-version"), "2023-06-01");
        return jsonResponse({
          data: [{ id: "claude-opus-4-6", type: "model" }],
          has_more: false,
        });
      }

      if (url === "http://ollama.test/api/tags") {
        return jsonResponse({ models: [] });
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const result = await catalog.list();

  assert.deepEqual(result.models, [
    {
      id: "anthropic/claude-opus-4-6",
      provider: "anthropic",
      config: {},
    },
    {
      id: "openai/gpt-5.1",
      provider: "openai",
      config: {
        reasoningEffort: { values: ["low", "medium", "high"] },
      },
    },
  ]);
});

test("discovers Groq and DeepSeek only when their documented keys are configured", async () => {
  const urls: string[] = [];
  const catalog = createModelCatalog({
    ollamaBaseUrl: "http://ollama.test/api",
    env: {
      GROQ_API_KEY: "groq-key",
      DEEPSEEK_API_KEY: "deepseek-key",
    },
    fetcher: async (input, init) => {
      const url = requestUrl(input);
      const authorization = new Headers(init?.headers).get("authorization");
      urls.push(url);

      if (url === "https://api.groq.com/openai/v1/models") {
        assert.equal(authorization, "Bearer groq-key");
        return jsonResponse({
          data: [
            { id: "llama-3.3-70b-versatile", active: true },
            { id: "whisper-large-v3", active: true },
            { id: "retired-model", active: false },
          ],
        });
      }

      if (url === "https://api.deepseek.com/models") {
        assert.equal(authorization, "Bearer deepseek-key");
        return jsonResponse({
          data: [
            { id: "deepseek-chat", object: "model" },
            { id: "deepseek-reasoner", object: "model" },
          ],
        });
      }

      if (url === "http://ollama.test/api/tags") {
        return jsonResponse({ models: [] });
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const result = await catalog.list();

  assert.deepEqual(urls.sort(), [
    "http://ollama.test/api/tags",
    "https://api.deepseek.com/models",
    "https://api.groq.com/openai/v1/models",
  ]);
  assert.deepEqual(result.models, [
    { id: "deepseek/deepseek-chat", provider: "deepseek", config: {} },
    { id: "deepseek/deepseek-reasoner", provider: "deepseek", config: {} },
    { id: "groq/llama-3.3-70b-versatile", provider: "groq", config: {} },
  ]);
});

test("keeps healthy providers when one configured provider fails", async () => {
  const catalog = createModelCatalog({
    ollamaBaseUrl: "http://ollama.test/api",
    env: {
      GOOGLE_API_KEY: "google-key",
      OPENAI_API_KEY: "openai-key",
    },
    fetcher: async (input) => {
      const url = requestUrl(input);
      if (url.startsWith("https://generativelanguage.googleapis.com/")) {
        return jsonResponse({
          models: [{
            name: "models/gemini-3.6-flash",
            supportedGenerationMethods: ["generateContent"],
            thinking: true,
          }],
        });
      }
      if (url === "https://api.openai.com/v1/models") {
        return jsonResponse({ error: { message: "invalid key" } }, 401);
      }
      return jsonResponse({ models: [] });
    },
  });

  const result = await catalog.list();

  assert.deepEqual(result.models.map(({ id }) => id), [
    "google/gemini-3.6-flash",
  ]);
  assert.deepEqual(result.warnings, ["OpenAI: returned HTTP 401."]);
});

test("summarizes malformed provider responses", async () => {
  const catalog = createModelCatalog({
    ollamaBaseUrl: "http://ollama.test/api",
    env: { GOOGLE_API_KEY: "google-key" },
    fetcher: async (input) => requestUrl(input).startsWith("https://")
      ? jsonResponse({ models: "invalid" })
      : jsonResponse({ models: [{ name: "local" }] }),
  });

  const result = await catalog.list();

  assert.deepEqual(result.models.map(({ id }) => id), ["ollama/local"]);
  assert.deepEqual(result.warnings, [
    "Google: response format is unsupported.",
  ]);
  assert.equal(result.warnings[0]?.includes("invalid_type"), false);
});

test("caches successful cloud discovery while refreshing Ollama", async () => {
  let googleCalls = 0;
  let ollamaCalls = 0;
  const catalog = createModelCatalog({
    ollamaBaseUrl: "http://ollama.test/api",
    env: { GOOGLE_API_KEY: "google-key" },
    fetcher: async (input) => {
      if (requestUrl(input).startsWith("https://")) {
        googleCalls += 1;
        return jsonResponse({
          models: [{
            name: "models/gemini-3.6-flash",
            supportedGenerationMethods: ["generateContent"],
            thinking: true,
          }],
        });
      }
      ollamaCalls += 1;
      return jsonResponse({ models: [{ name: `local-${ollamaCalls}` }] });
    },
  });

  const first = await catalog.list();
  const second = await catalog.list();

  assert.equal(googleCalls, 1);
  assert.equal(ollamaCalls, 2);
  assert.equal(first.models.some(({ id }) => id === "ollama/local-1"), true);
  assert.equal(second.models.some(({ id }) => id === "ollama/local-2"), true);
});

test("propagates cancellation instead of returning a partial catalog", async () => {
  const abortController = new AbortController();
  abortController.abort();
  const catalog = createModelCatalog({
    ollamaBaseUrl: "http://ollama.test/api",
    env: { GOOGLE_API_KEY: "key" },
    fetcher: async () => jsonResponse({ models: [] }),
  });

  await assert.rejects(
    catalog.list(abortController.signal),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});

test("find returns an exact nested OpenRouter model ID", async () => {
  const catalog = createModelCatalog({
    ollamaBaseUrl: "http://ollama.test/api",
    env: { OPENROUTER_API_KEY: "key" },
    fetcher: async (input) => requestUrl(input).startsWith("https://")
      ? jsonResponse({
          data: [{ id: "openai/gpt-5.1", supported_parameters: ["reasoning"] }],
        })
      : jsonResponse({ models: [] }),
  });

  const entry = await catalog.find("openrouter/openai/gpt-5.1");

  assert.equal(entry?.id, "openrouter/openai/gpt-5.1");
});
