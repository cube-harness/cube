import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPClient } from "@mastra/mcp";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { AuthStore, CubeHome, CubeWorkspace, RunnableConfigSchema, createBootstrap, parseMcpConfig } from "@cube/workspace";
import { MockLanguageModelV3 } from "ai/test";
import { createCubeMastra } from "../src/bootstrap.js";
import { configureCubePermissions } from "../src/permission.js";
import { CubeMcp } from "../src/mcp/client.js";

const tool = createTool({ id: "lookup", description: "Lookup", inputSchema: z.object({}), execute: async () => "ok" });
const snapshot = (servers: Record<string, unknown>) => parseMcpConfig({ mcpServers: servers });
const config = { good: { command: "node" }, broken: { command: "missing-command" }, empty: { command: "node" } };

test("discovery isolates failures, config reload reuses connections, and policies precede publication", async t => {
  const root = await mkdtemp(join(tmpdir(), "cube-mcp-client-"));
  const manager = new CubeMcp({ auth: new AuthStore(CubeHome({ cubeHome: root })), workspaceRoot: root });
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  const connections = new WeakMap<MCPClient, string>();
  let discovers = 0, reconnects = 0, disconnects = 0;
  const names = ["good", "broken", "empty"];
  t.mock.method(MCPClient.prototype, "listToolsWithErrors", async function(this: MCPClient) {
    let name = connections.get(this);
    if (!name) { name = names[discovers]!; connections.set(this, name); }
    discovers++;
    return { tools: name === "good" ? { good_lookup: tool } : {},
      errors: name === "broken" ? { broken: "Connection failed" } : {}, errorDetails: {} };
  });
  t.mock.method(MCPClient.prototype, "getServerAuthState", () => "connected");
  t.mock.method(MCPClient.prototype, "reconnectServer", async () => { reconnects++; });
  t.mock.method(MCPClient.prototype, "disconnect", async () => { disconnects++; });
  const published: string[][] = [];
  const policy = async (names: string[]) => { assert.deepEqual(manager.readToolNames(), []); published.push(names); };
  await manager.reload(snapshot(config), policy);
  assert.deepEqual(manager.readToolNames(), ["good_lookup"]);
  assert.deepEqual(manager.get().servers.map(s => [s.name, s.status]), [["broken", "error"], ["empty", "connected"], ["good", "connected"]]);
  assert.deepEqual(published[0], ["good_lookup"]);
  await manager.reload(snapshot(config), async () => undefined);
  assert.equal(discovers, 3);
  await manager.restart("good", policy);
  assert.equal(reconnects, 1);
  assert.equal(discovers, 4);
  await manager.reload(snapshot({ ...config, good: { command: "node", disabled: true } }), async () => undefined);
  assert.deepEqual(manager.readToolNames(), []);
  assert.equal(disconnects, 1);
  await manager.reload({ servers: {}, errors: {}, error: "Bad JSON" }, async () => undefined);
  assert.equal(manager.get().servers.length, 3);
  await manager.dispose();
  await manager.dispose();
  assert.equal(disconnects, 3);
});

test("late discovery after disable cannot install old tools, and permission failures stay in MCP state", async t => {
  const root = await mkdtemp(join(tmpdir(), "cube-mcp-late-"));
  const manager = new CubeMcp({ auth: new AuthStore(CubeHome({ cubeHome: root })), workspaceRoot: root });
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(MCPClient.prototype, "listToolsWithErrors", async () => { started(); await gate; return { tools: { good_lookup: tool }, errors: {}, errorDetails: {} }; });
  t.mock.method(MCPClient.prototype, "disconnect", async () => undefined);
  const discovery = manager.reload(snapshot({ good: { command: "node" } }), async () => undefined);
  await pending;
  await manager.reload(snapshot({ good: { command: "node", disabled: true } }), async () => undefined);
  release(); await discovery;
  assert.deepEqual(manager.readToolNames(), []);
  assert.equal(manager.get().servers[0]!.status, "disabled");
  await manager.reload(snapshot({ good: { command: "node" } }), async () => { throw new Error("Cannot assign Ask"); });
  assert.deepEqual(manager.readToolNames(), []);
  assert.equal(manager.get().servers[0]!.status, "error");
  assert.match(manager.get().error!, /Cannot assign Ask/);
});

test("OAuth setup failure and cancellation before URL settle without late credential resurrection", async t => {
  const root = await mkdtemp(join(tmpdir(), "cube-mcp-auth-"));
  const home = CubeHome({ cubeHome: root });
  await home.ensure();
  const auth = new AuthStore(home);
  await writeFile(home.getAuthPath(), JSON.stringify({ api_keys: {}, oauth: {}, mcp: {} }));
  const manager = new CubeMcp({ auth, workspaceRoot: root });
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  t.mock.method(MCPClient.prototype, "listToolsWithErrors", async () => ({ tools: {}, errors: { docs: "Authorization required" }, errorDetails: {} }));
  t.mock.method(MCPClient.prototype, "getServerAuthState", () => "needs-auth");
  t.mock.method(MCPClient.prototype, "disconnect", async () => undefined);
  const authenticate = t.mock.method(MCPClient.prototype, "authenticate", async () => { throw new Error("Registration rejected: client-secret"); });
  await manager.reload(snapshot({ docs: { url: "https://example.test/mcp", oauth: { client_id: "cube", client_secret: "client-secret" } } }), async () => undefined);
  await assert.rejects(manager.beginLogin("docs", async () => undefined), /Registration rejected: \[Redacted\]/);
  assert.equal(JSON.stringify(manager.get()).includes("client-secret"), false);
  let started!: () => void, reject!: (error: Error) => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  authenticate.mock.mockImplementation(async () => { started(); await new Promise<void>((_resolve, fail) => { reject = fail; }); });
  t.mock.method(MCPClient.prototype, "cancelAuthentication", async () => { reject?.(new Error("Cancelled")); });
  const login = manager.beginLogin("docs", async () => undefined);
  const rejected = assert.rejects(login, /Cancelled/);
  await waiting; await manager.cancelLogin("docs"); await rejected;
  assert.deepEqual(manager.readToolNames(), []);
  assert.equal(manager.get().servers[0]!.status, "needs-auth");
  assert.deepEqual(await auth.getMcpValues("docs", "https://example.test/mcp"), {});
  // Esc can happen before beginLogin's first await resumes, not only during authenticate.
  await manager.reload(snapshot({ docs: { url: "https://example.test/mcp", timeout: 1000 } }), async () => undefined);
  const immediate = manager.beginLogin("docs", async () => undefined);
  const cancelled = assert.rejects(immediate, /cancelled/);
  await manager.cancelLogin("docs");
  await cancelled;
});

test("agent-owned MCP tools obey real Session approval, decline, Allow and Deny", { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "cube-mcp-agent-"));
  const home = CubeHome({ cubeHome: join(root, "home"), userHome: root });
  t.mock.method(home, "getMemoryDbPath", () => ":memory:");
  await createBootstrap(home).run();
  let executions = 0, gates = 0, issueTool = false, decision: "approve" | "decline" = "decline", call = 0;
  const executable = createTool({ id: "lookup", description: "Lookup", inputSchema: z.object({}), execute: async () => { executions++; return "READ_RESULT"; } });
  t.mock.method(MCPClient.prototype, "listToolsWithErrors", async () => ({ tools: { docs_lookup: executable }, errors: {}, errorDetails: {} }));
  t.mock.method(MCPClient.prototype, "disconnect", async () => undefined);
  const config = RunnableConfigSchema.parse({ gateway: "api_key/google", model: "google/test", memory: { durable: { enabled: false } } });
  const composition = await createCubeMastra(home, CubeWorkspace(home, root), config);
  const session = await composition.controller.createSession({ resourceId: root });
  t.after(async () => {
    session.thread.detachFromCurrent(); await session.thread.clearAndReleaseLock();
    await composition.shutdown(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await composition.mcp.reload(snapshot({ docs: { command: "node" } }), names => configureCubePermissions(session, { require_approval_for: [] }, names).then(() => undefined));
  assert.ok((await composition.agent.listTools()).docs_lookup);
  composition.agent.model = new MockLanguageModelV3({ doStream: async () => {
    const sendTool = issueTool; issueTool = false;
    return { stream: new ReadableStream({ start(stream) {
      stream.enqueue({ type: "stream-start", warnings: [] });
      if (sendTool) stream.enqueue({ type: "tool-call", toolCallId: `mcp-${call++}`, toolName: "docs_lookup", input: "{}" });
      stream.enqueue({ type: "finish", finishReason: { unified: sendTool ? "tool-calls" : "stop", raw: sendTool ? "tool_calls" : "stop" },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } });
      stream.close();
    } }) };
  } });
  session.subscribe(event => {
    if (event.type === "tool_approval_required") { gates++; session.respondToToolApproval({ decision, toolCallId: event.toolCallId }); }
  });
  await session.thread.create({ id: "mcp-gates" });
  for (const policy of ["decline", "approve", "allow", "deny"] as const) {
    decision = policy === "approve" ? "approve" : "decline";
    await configureCubePermissions(session, { require_approval_for: [],
      allow_for: policy === "allow" ? ["docs_lookup"] : [], deny_for: policy === "deny" ? ["docs_lookup"] : [] }, ["docs_lookup"]);
    issueTool = true;
    await session.followUp({ content: `Run MCP (${policy})` });
    assert.equal(executions, policy === "decline" ? 0 : policy === "approve" ? 1 : 2);
  }
  assert.equal(gates, 2);
});
