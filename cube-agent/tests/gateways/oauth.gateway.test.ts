import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayLanguageModel } from "@mastra/core/llm";
import { OAuthGateway } from "../../src/gateways/oauth.gateway.js";
import { buildModelConfig } from "../../src/agents/main.agent.js";

const credential = {
  access_token: "oauth-token",
  refresh_token: "refresh-token",
  expires_at: Date.now() + 60_000,
  account_id: "account-1",
};

test("Anthropic native Messages adapter preserves tools and refreshes bearer without an API key", async context => {
  let token = "initial";
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  context.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } });
  });
  const gateway = new OAuthGateway({
    openai: { getValidCredential: async () => { throw new Error("wrong credential provider"); } },
    anthropic: { getValidCredential: async () => ({ access_token: token, refresh_token: "refresh", expires_at: Date.now() + 3600000 }) },
  });
  const auth = await gateway.resolveAuth({ providerId: "anthropic" } as Parameters<OAuthGateway["resolveAuth"]>[0]);
  const model = await gateway.resolveLanguageModel({ providerId: "anthropic", modelId: "claude-sonnet-4-6", apiKey: auth.apiKey!, headers: auth.headers });
  const prompt = [
    { role: "system" as const, content: "Cube instructions" },
    { role: "user" as const, content: [{ type: "text" as const, text: "read file" }] },
    { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "call_1", toolName: "read_file", input: { path: "test.ts" } }] },
    { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "call_1", toolName: "read_file", output: { type: "text" as const, value: "contents" } }] },
  ];
  for (const value of ["first", "replacement"]) {
    token = value;
    const result = await model.doStream({ prompt, tools: [{ type: "function", name: "read_file", inputSchema: { type: "object" } }], toolChoice: { type: "tool", toolName: "read_file" } });
    await result.stream.cancel();
  }
  assert.equal(gateway.buildUrl("cube-oauth/anthropic/claude-sonnet-4-6"), "https://api.anthropic.com/v1/messages");
  assert.deepEqual(requests.map(row => row.headers.get("authorization")), ["Bearer first", "Bearer replacement"]);
  for (const request of requests) {
    assert.equal(request.url, "https://api.anthropic.com/v1/messages");
    assert.equal(request.headers.get("x-api-key"), null);
    assert.equal(request.headers.get("chatgpt-account-id"), null);
    assert.match(request.headers.get("anthropic-beta")!, /oauth-2025-04-20/);
    assert.ok(request.body.system.some((row: any) => row.text === "Cube instructions"));
    assert.equal(request.body.tools[0].name, "read_file");
    assert.equal(request.body.tool_choice.name, "read_file");
    assert.ok(request.body.messages.some((row: any) => row.content.some((part: any) => part.type === "tool_result" && part.tool_use_id === "call_1")));
  }
  assert.equal(prompt.length, 4);
  assert.equal(prompt[0]?.content, "Cube instructions");
});

test("Grok cached adapter re-reads credentials for each request and sends configured effort only on supported models", async context => {
  let token = "old";
  const requests: Array<{ token: string | null; body: any }> = [];
  context.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push({ token: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const gateway = new OAuthGateway({ openai: { getValidCredential: async () => credential },
    xai: { getValidCredential: async () => ({ access_token: token, refresh_token: "refresh", expires_at: Date.now() + 3600000 }) },
  });
  const model = await gateway.resolveLanguageModel({ providerId: "xai", modelId: "grok-4.5", apiKey: "old" });
  const config = buildModelConfig("cube-oauth/xai/grok-4.5", "low");
  for (const value of ["first-account", "replacement-account"]) {
    token = value;
    const result = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }], providerOptions: config.providerOptions });
    await result.stream.cancel();
  }
  assert.deepEqual(requests.map(request => request.token), ["Bearer first-account", "Bearer replacement-account"]);
  assert.equal(requests[0]?.body.reasoning?.effort, "low");
  assert.equal(buildModelConfig("cube-api/xai/grok-4.5", "low").providerOptions, undefined);
});

test("Grok Build uses its own bearer, Responses endpoint, and preserves system/tools across turns", async (context) => {
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  context.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const gateway = new OAuthGateway({
    openai: { getValidCredential: async () => { throw new Error("must not use OpenAI credentials"); } },
    xai: { getValidCredential: async () => ({ access_token: "grok-access", refresh_token: "grok-refresh", expires_at: Date.now() + 3600000 }) },
  });
  const auth = await gateway.resolveAuth({ gatewayId: "cube-oauth", providerId: "xai", modelId: "grok-build", routerId: "cube-oauth/xai/grok-build" });
  const model = await gateway.resolveLanguageModel({ providerId: "xai", modelId: "grok-build", apiKey: auth.apiKey!, headers: auth.headers });
  const response = await model.doStream({ prompt: [
    { role: "system", content: "Cube instructions" },
    { role: "user", content: [{ type: "text", text: "read file" }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_1", toolName: "read_file", input: { path: "test.ts" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "read_file", output: { type: "text", value: "contents" } }] },
  ], tools: [{ type: "function", name: "read_file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    providerOptions: { openai: { reasoningEffort: "high" } } });
  await response.stream.cancel();
  const request = requests[0]!;
  assert.equal(request.url, "https://cli-chat-proxy.grok.com/v1/responses");
  assert.equal(request.headers.get("authorization"), "Bearer grok-access");
  assert.equal(request.headers.get("chatgpt-account-id"), null);
  assert.equal(request.headers.get("x-xai-token-auth"), "xai-grok-cli");
  assert.equal(request.headers.get("x-grok-model-override"), "grok-build");
  assert.equal(request.body.store, false);
  assert.equal(request.body.stream, true);
  assert.equal(request.body.input[0].role, "system");
  assert.ok(request.body.input.some((item: any) => item.type === "function_call" && item.call_id === "call_1"));
  assert.ok(request.body.input.some((item: any) => item.type === "function_call_output" && item.output === "contents"));
  assert.equal(request.body.tools[0].name, "read_file");
  assert.equal(request.body.reasoning?.effort, undefined);
});

test("uses an isolated internal route and oauth auth headers", async () => {
  const gateway = new OAuthGateway(
    { openai: { getValidCredential: async () => credential } },
    {
      resolveLanguageModel: (args) => ({
        specificationVersion: "v3",
        modelId: `${args.providerId}/${args.modelId}`,
      } as GatewayLanguageModel),
    },
  );

  assert.equal(gateway.id, "cube-oauth");
  assert.equal(
    gateway.buildUrl(`${gateway.id}/openai/gpt-5.5`, {}),
    "https://chatgpt.com/backend-api/codex/responses",
  );
  assert.deepEqual(await gateway.resolveAuth({
    gatewayId: gateway.id,
    providerId: "openai",
    modelId: "gpt-5.5",
    routerId: `${gateway.id}/openai/gpt-5.5`,
  }), {
    bearerToken: "oauth-token",
    apiKey: "oauth-token",
    headers: { "ChatGPT-Account-Id": "account-1" },
    source: "gateway",
  });
});

test("provider descriptors do not freeze account model IDs at bootstrap", async () => {
  const gateway = new OAuthGateway(
    { openai: { getValidCredential: async () => credential } },
    { resolveLanguageModel: () => ({ specificationVersion: "v3" } as GatewayLanguageModel) },
  );

  const providers = await gateway.fetchProviders();
  assert.deepEqual(providers.openai?.models, []);
  assert.equal(providers.openai?.gateway, "cube-oauth");
  assert.equal(providers.openai?.url, "https://chatgpt.com/backend-api/codex");
});

test("oauth stream applies Codex request options without changing the canonical prompt", async () => {
  let received: any;
  const gateway = new OAuthGateway(
    { openai: { getValidCredential: async () => credential } },
    { resolveLanguageModel: () => ({
      specificationVersion: "v3", provider: "openai.responses", modelId: "gpt-5.5", supportedUrls: {},
      doStream: async (options: unknown) => {
        received = options;
        return { stream: new ReadableStream({ start(controller) { controller.close(); } }) };
      },
    } as GatewayLanguageModel) },
  );
  const model = await gateway.resolveLanguageModel({ providerId: "openai", modelId: "gpt-5.5", apiKey: "test" });
  const prompt = [{ role: "system" as const, content: "Cube instructions" },
    { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }];
  await model.doStream({ prompt, temperature: 0.3, maxOutputTokens: 1024,
    providerOptions: { openai: { reasoningEffort: "low" } } });
  assert.equal(received.providerOptions.openai.store, false);
  assert.equal(received.providerOptions.openai.instructions, "Cube instructions");
  assert.equal(received.providerOptions.openai.reasoningEffort, "low");
  assert.deepEqual(received.prompt, [prompt[1]]);
  assert.equal(received.temperature, undefined);
  assert.equal(received.maxOutputTokens, undefined);
  assert.equal(prompt.length, 2);
});

test("installed Mastra adapter sends the Codex endpoint, account header, and stateless body", async (context) => {
  let request: { url: string; headers: Headers; body: any } | undefined;
  context.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    request = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const gateway = new OAuthGateway({ openai: { getValidCredential: async () => credential } });
  const auth = await gateway.resolveAuth({ providerId: "openai" } as Parameters<OAuthGateway["resolveAuth"]>[0]);
  const model = await gateway.resolveLanguageModel({ providerId: "openai", modelId: "gpt-5.5",
    apiKey: auth.apiKey!, headers: auth.headers });
  const response = await model.doStream({ prompt: [
    { role: "system", content: "Cube instructions" },
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ], temperature: 0.3, maxOutputTokens: 100 });
  await response.stream.cancel();
  assert.equal(request?.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(request?.headers.get("chatgpt-account-id"), "account-1");
  assert.equal(request?.headers.get("authorization"), "Bearer oauth-token");
  assert.equal(request?.body.store, false);
  assert.equal(request?.body.stream, true);
  assert.equal(request?.body.instructions, "Cube instructions");
  assert.equal(request?.body.max_output_tokens, undefined);
  assert.equal(request?.body.temperature, undefined);
});

test("new OAuth ID routes after bootstrap and cached adapter honors account replacement and logout", async t => {
  let stored: typeof credential | undefined = credential;
  const requests: Array<{ url: string; headers: Headers }> = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init.headers) });
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const gateway = new OAuthGateway({ openai: { getValidCredential: async () => {
    if (!stored) throw new Error("Missing credential");
    return stored;
  } } });
  const model = await gateway.resolveLanguageModel({ providerId: "openai", modelId: "new-account-model", apiKey: "bootstrap-token" });
  const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }];
  for (const account of ["first", "second"]) {
    stored = { ...credential, access_token: account + "-token", account_id: account };
    const response = await model.doStream({ prompt });
    await response.stream.cancel();
  }
  assert.deepEqual(requests.map(item => item.headers.get("authorization")), ["Bearer first-token", "Bearer second-token"]);
  assert.deepEqual(requests.map(item => item.headers.get("chatgpt-account-id")), ["first", "second"]);
  assert.ok(requests.every(item => item.url.endsWith("/codex/responses")));
  stored = undefined;
  await assert.rejects(() => model.doStream({ prompt }), /Missing credential/);
  assert.equal(requests.length, 2);
});
