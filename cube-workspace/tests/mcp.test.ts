import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CubeHome, McpStore, mcpConnectionKey, parseMcpConfig, resolveToolPermission } from "../src/index.js";

test("MCP parser isolates malformed entries and strips unknown security options", () => {
  const snapshot = parseMcpConfig({ mcpServers: {
    good: { command: "node", args: ["server.mjs"], forwardInstructions: true },
    http: { type: "sse", url: "https://example.test/mcp" },
    both: { command: "node", url: "https://example.test" },
    badTimeout: { command: "node", timeout: 0 },
    file: { url: "file:///secrets" },
  } });
  assert.deepEqual(Object.keys(snapshot.servers), ["good", "http"]);
  assert.deepEqual(Object.keys(snapshot.errors), ["both", "badTimeout", "file"]);
  assert.equal(snapshot.servers.good!.timeout, 60_000);
  assert.equal("forwardInstructions" in snapshot.servers.good!, false);
  assert.equal(snapshot.servers.http!.type, "http");
  assert.equal("connectTimeout" in snapshot.servers.http! && snapshot.servers.http.connectTimeout, 3_000);
  const reordered = parseMcpConfig({ mcpServers: { a: { url: "https://example.test/mcp", headers: { B: "two", A: "one" } },
    b: { headers: { A: "one", B: "two" }, disabled: true, url: "https://example.test/mcp" } } });
  assert.equal(mcpConnectionKey(reordered.servers.a!), mcpConnectionKey(reordered.servers.b!));
});

test("MCP toggles preserve manual fields and reject stale connection settings", async t => {
  const root = await mkdtemp(join(tmpdir(), "cube-mcp-config-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = CubeHome({ cubeHome: root });
  const store = McpStore(home);
  assert.deepEqual(await store.read(), { servers: {}, errors: {} });
  const document = { comment: "keep", mcpServers: {
    selected: { command: "node", args: ["server.mjs"], future: "keep" },
    other: { url: "https://example.test/mcp", headers: { Authorization: "secret" } },
  } };
  await writeFile(home.getMcpPath(), JSON.stringify(document));
  const key = mcpConnectionKey((await store.read()).servers.selected!);
  await store.setDisabled("selected", true, key);
  assert.deepEqual(JSON.parse(await readFile(home.getMcpPath(), "utf8")), {
    ...document, mcpServers: { ...document.mcpServers, selected: { ...document.mcpServers.selected, disabled: true } },
  });
  document.mcpServers.selected.args = ["different.mjs"];
  await writeFile(home.getMcpPath(), JSON.stringify(document));
  const before = await readFile(home.getMcpPath(), "utf8");
  await assert.rejects(store.setDisabled("selected", false, key), /changed/);
  assert.equal(await readFile(home.getMcpPath(), "utf8"), before);
  await writeFile(home.getMcpPath(), "{broken");
  assert.ok((await store.read()).error);
});

test("MCP tools default to Ask while explicit Deny and Ask outrank saved Allow", () => {
  for (const [name, policies, expected] of [
    ["mcp_docs_search", { require_approval_for: [] }, "ask"],
    ["read_file", { require_approval_for: [] }, "allow"],
    ["mcp_docs_search", { require_approval_for: [], allow_for: ["mcp_docs_search"] }, "allow"],
    ["mcp_docs_search", { require_approval_for: ["mcp_docs_search"], allow_for: ["mcp_docs_search"] }, "ask"],
    ["mcp_docs_search", { require_approval_for: ["mcp_docs_search"], deny_for: ["mcp_docs_search"] }, "deny"],
  ] as const) assert.equal(resolveToolPermission(name, { ...policies, require_approval_for: [...policies.require_approval_for] } as never), expected);
});

test("pre-registered OAuth clients are validated and participate in connection identity", () => {
  const snapshot = parseMcpConfig({ mcpServers: {
    registered: { url: "https://example.test/mcp", oauth: { client_id: "cube", client_secret: "secret" } },
    public: { url: "https://example.test/mcp", oauth: { client_id: "public-cube" } },
    dcr: { url: "https://example.test/mcp" },
    missingId: { url: "https://example.test/mcp", oauth: { client_secret: "secret" } },
    emptySecret: { url: "https://example.test/mcp", oauth: { client_id: "cube", client_secret: "" } },
    stdio: { command: "node", oauth: { client_id: "cube" } },
    conflicting: { url: "https://example.test/mcp", headers: { authorization: "Bearer key" }, oauth: { client_id: "cube" } },
  } });
  assert.deepEqual(Object.keys(snapshot.servers), ["registered", "public", "dcr"]);
  assert.deepEqual(Object.keys(snapshot.errors), ["missingId", "emptySecret", "stdio", "conflicting"]);
  const registered = snapshot.servers.registered!;
  assert.equal(registered.type === "http" && registered.oauth?.client_id, "cube");
  const changed = parseMcpConfig({ mcpServers: {
    id: { url: "https://example.test/mcp", oauth: { client_id: "other", client_secret: "secret" } },
    secret: { url: "https://example.test/mcp", oauth: { client_id: "cube", client_secret: "other-secret" } },
    reordered: { url: "https://example.test/mcp", oauth: { client_secret: "secret", client_id: "cube" } },
  } });
  assert.notEqual(mcpConnectionKey(registered), mcpConnectionKey(changed.servers.id!));
  assert.notEqual(mcpConnectionKey(registered), mcpConnectionKey(changed.servers.secret!));
  assert.equal(mcpConnectionKey(registered), mcpConnectionKey(changed.servers.reordered!));
});
