import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, CubeHome, atomicWriteFile, createBootstrap, parseMcpConfig } from "@cube/workspace";
import { MCPOAuthClientProvider } from "@mastra/mcp";
import { CubeMcp } from "../src/mcp/client.js";

// Protocol fixture: real native HTTP transport, discovery, callback, PKCE and token storage.
for (const registered of [false, true]) test(`native MCP OAuth (${registered ? "registered client" : "DCR"}) completes PKCE, reuses credentials, and isolates logout`, { timeout: 20_000 }, async t => {
  let provider!: MCPOAuthClientProvider;
  const readTokens = MCPOAuthClientProvider.prototype.tokens;
  t.mock.method(MCPOAuthClientProvider.prototype, "tokens", function(this: MCPOAuthClientProvider) { provider = this; return readTokens.call(this); });
  let base = "", challenge = "", tokens = 0, registrations = 0;
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, base);
    requests.push({ path: url.pathname, method: request.method, authorized: request.headers.authorization === "Bearer fixture-token" });
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const json = (value: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) return json({ issuer: base,
      authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
      ...(registered ? {} : { registration_endpoint: `${base}/register` }),
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], ...(registered ? {} : { token_endpoint_auth_methods_supported: ["none"] }) });
    if (url.pathname === "/register") {
      registrations++;
      return registered ? json({ error: "registration_not_supported" }, 404)
        : json({ ...JSON.parse(raw), client_id: "fixture-cube", token_endpoint_auth_method: "none" }, 201);
    }
    if (url.pathname === "/authorize") {
      challenge = url.searchParams.get("code_challenge")!;
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", "fixture-code");
      redirect.searchParams.set("state", url.searchParams.get("state")!);
      response.writeHead(302, { Location: redirect.href }); response.end(); return;
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(raw);
      if (registered && request.headers.authorization !== `Basic ${Buffer.from("fixture-cube:fixture-client-secret").toString("base64")}`)
        return json({ error: "invalid_client" }, 401);
      if (form.get("code") !== "fixture-code" || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== challenge)
        return json({ error: "invalid_grant" }, 400);
      tokens++;
      return json({ access_token: "fixture-token", token_type: "Bearer", refresh_token: "fixture-refresh", expires_in: 3600 });
    }
    if (url.pathname !== "/mcp") return json({ error: "not found" }, 404);
    if (request.headers.authorization !== "Bearer fixture-token") {
      response.setHeader("WWW-Authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
      return json({ error: "unauthorized" }, 401);
    }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    const message = JSON.parse(raw);
    if (message.id === undefined) { response.writeHead(202); response.end(); return; }
    const result = message.method === "initialize" ? {
      protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" }, instructions: "NEVER INJECT THIS SERVER INSTRUCTION",
    } : message.method === "tools/list" ? { tools: [{ name: "search", description: "Read-only search", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }
      : { content: [{ type: "text", text: "FOUND" }] };
    return json({ jsonrpc: "2.0", id: message.id, result });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = await mkdtemp(join(tmpdir(), "cube-mcp-http-"));
  const home = CubeHome({ cubeHome: root, userHome: root });
  await createBootstrap(home).run();
  const auth = new AuthStore(home);
  await auth.replaceApiKey("google", "gateway-key");
  await auth.updateMcpValues("other", "https://other.test/mcp", () => ({ tokens: "other-token" }));
  const client = new CubeMcp({ auth, workspaceRoot: root });
  const oauth = registered ? { client_id: "fixture-cube", client_secret: "fixture-client-secret" } : undefined;
  const snapshot = parseMcpConfig({ mcpServers: { docs: { url: `${base}/mcp`, timeout: 5000, oauth } } });
  const publish = async () => undefined;
  let restarted: CubeMcp | undefined;
  t.after(async () => {
    await client.dispose(); await restarted?.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await client.reload(snapshot, publish);
  assert.equal(client.get().servers[0]!.status, "needs-auth");
  const login = await client.beginLogin("docs", publish);
  assert.equal(new URL(login.authorizationUrl).searchParams.get("client_id"), "fixture-cube");
  const before = await auth.getMcpValues("docs", `${base}/mcp`);
  assert.equal(before.code_verifier, undefined, "PKCE verifier stays in RAM");
  const callback = await fetch(login.authorizationUrl);
  assert.equal(callback.status, 200);
  await login.completion;
  assert.equal(registrations, registered ? 0 : 1, "pre-registered clients never attempt DCR");
  assert.equal(tokens, 1);
  assert.equal(client.get().servers[0]!.status, "connected");
  assert.deepEqual(client.readToolNames(), ["docs_search"]);
  assert.match(JSON.stringify(await client.readTools().docs_search!.execute!({}, {} as never)), /FOUND/);
  await client.dispose();
  restarted = new CubeMcp({ auth: new AuthStore(home), workspaceRoot: root });
  await restarted.reload(snapshot, publish);
  assert.equal(restarted.get().servers[0]!.status, "connected", JSON.stringify({ state: restarted.get(), requests, stored: Object.keys(await auth.getMcpValues("docs", `${base}/mcp`)) }));
  assert.equal(tokens, 1, "restart uses stored token without a second login");
  if (registered) {
    for (const changed of [{ ...oauth!, client_id: "other-client" }, { ...oauth!, client_secret: "other-secret" }]) {
      await restarted.reload(parseMcpConfig({ mcpServers: { docs: { url: `${base}/mcp`, timeout: 5000, oauth: changed } } }), publish);
      assert.equal(restarted.get().servers[0]!.status, "needs-auth", "changed OAuth client cannot reuse the old token");
      assert.deepEqual(restarted.readToolNames(), []);
    }
    await restarted.reload(snapshot, publish);
    assert.equal(restarted.get().servers[0]!.status, "needs-auth", "replacing the configured client discards its old credential snapshot");
    const relogin = await restarted.beginLogin("docs", publish);
    await fetch(relogin.authorizationUrl);
    await relogin.completion;
    assert.equal(restarted.get().servers[0]!.status, "connected");
    assert.equal(tokens, 2);
  }
  let writing!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { writing = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const delayedStore = new AuthStore(home, async (path, contents, options) => { writing(); await gate; await atomicWriteFile(path, contents, options); });
  const delayed = delayedStore.replaceApiKey("google", "updated-gateway-key");
  await started;
  const lateToken = provider.saveTokens({ access_token: "late-token", token_type: "Bearer" });
  const rejected = assert.rejects(lateToken, /cancelled/);
  const logout = restarted.logout("docs", publish);
  release(); await delayed; await rejected; await logout;
  assert.deepEqual(restarted.readToolNames(), []);
  assert.deepEqual(await auth.getMcpValues("docs", `${base}/mcp`), {});
  assert.deepEqual(await auth.getMcpValues("other", "https://other.test/mcp"), { tokens: "other-token" });
  assert.equal(await auth.getApiKey("google"), "updated-gateway-key");
});

test("HTTP and native SSE fallback preserve static Authorization without adding OAuth", { timeout: 15_000 }, async t => {
  let base = "";
  let stream: import("node:http").ServerResponse | undefined;
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer test-static") { response.writeHead(401); response.end(); return; }
    const url = new URL(request.url!, base);
    methods.push(`${request.method} ${url.pathname}`);
    if (url.pathname === "/sse" && request.method === "GET") {
      stream = response;
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.write("event: endpoint\ndata: /messages\n\n"); return;
    }
    if (request.method !== "POST" || !["/mcp", "/messages"].includes(url.pathname)) { response.writeHead(405); response.end(); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    const message = JSON.parse(raw);
    if (message.id === undefined) { response.writeHead(202); response.end(); return; }
    const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: [] } : { content: [] };
    const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    if (url.pathname === "/messages") { response.writeHead(202); response.end(); stream!.write(`event: message\ndata: ${body}\n\n`); }
    else { response.writeHead(200, { "Content-Type": "application/json" }); response.end(body); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = await mkdtemp(join(tmpdir(), "cube-mcp-static-"));
  const client = new CubeMcp({ auth: new AuthStore(CubeHome({ cubeHome: root })), workspaceRoot: root });
  t.after(async () => { await client.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  await client.reload(parseMcpConfig({ mcpServers: {
    http: { url: `${base}/mcp`, headers: { Authorization: "Bearer test-static" }, timeout: 3000 },
    sse: { url: `${base}/sse`, type: "sse", headers: { Authorization: "Bearer test-static" }, timeout: 3000 },
  } }), async () => undefined);
  assert.deepEqual(client.get().servers.map(s => [s.name, s.status, s.oauth]), [["http", "connected", false], ["sse", "connected", false]], JSON.stringify(client.get()));
  assert.ok(methods.includes("GET /sse"));
  assert.ok(methods.includes("POST /messages"));
});
