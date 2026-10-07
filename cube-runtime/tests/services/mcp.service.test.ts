import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { CubeMcp } from "@cube/agent";
import { AuthStore, CubeHome, McpStore, createBootstrap } from "@cube/workspace";
import { McpService } from "../../src/services/mcp.service.js";
const requireFromAgent = createRequire(import.meta.resolve("@cube/agent"));
const { MCPClient } = await import(new URL("./dist/index.js", pathToFileURL(requireFromAgent.resolve("@mastra/mcp/package.json"))).href);

test("MCP mutation guard prevents concurrent actions and clears after pre-URL login failure", async t => {
  const root = await mkdtemp(join(tmpdir(), "cube-mcp-service-"));
  const home = CubeHome({ cubeHome: root, userHome: root });
  await createBootstrap(home).run();
  await writeFile(home.getMcpPath(), JSON.stringify({ mcpServers: { docs: { url: "https://example.test/mcp" } } }));
  const client = new CubeMcp({ auth: new AuthStore(home), workspaceRoot: root });
  const store = McpStore(home);
  let busy = true;
  const service = new McpService({ client, store, isBusy: () => busy, beforePublish: async () => undefined });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  t.mock.method(MCPClient.prototype, "listToolsWithErrors", async () => ({ tools: {}, errors: { docs: "Needs auth" }, errorDetails: {} }));
  t.mock.method(MCPClient.prototype, "getServerAuthState", () => "needs-auth");
  t.mock.method(MCPClient.prototype, "authenticate", async () => { throw new Error("No authorization URL"); });
  t.mock.method(MCPClient.prototype, "disconnect", async () => undefined);
  await assert.rejects(service.reload(), /current operation/);
  assert.equal(service.isApplying(), false);
  busy = false;
  await service.reload();
  assert.equal(service.get().servers[0]!.status, "needs-auth");
  const login = service.beginLogin("docs");
  assert.equal(service.isApplying(), true);
  await assert.rejects(service.restart("docs"), /current operation/);
  await assert.rejects(login, /No authorization URL/);
  assert.equal(service.isApplying(), false);
  const before = await readFile(home.getMcpPath(), "utf8");
  t.mock.method(store, "setDisabled", async () => { throw new Error("Disk unavailable"); });
  await assert.rejects(service.setEnabled("docs", false), /Disk unavailable/);
  assert.equal(service.isApplying(), false);
  assert.equal(service.get().servers[0]!.status, "needs-auth");
  assert.equal(await readFile(home.getMcpPath(), "utf8"), before);
});

test("cancelling OAuth keeps the mutation guard until callback/client teardown finishes", async () => {
  let reject!: (error: Error) => void, release!: () => void;
  const completion = new Promise<void>((_resolve, fail) => { reject = fail; });
  const teardown = new Promise<void>(resolve => { release = resolve; });
  const client = {
    beginLogin: async () => ({ authorizationUrl: "https://example.test/authorize", expiresAt: Date.now() + 300000, completion, cancel: async () => undefined }),
    cancelLogin: async () => { reject(new Error("cancelled")); await teardown; },
  } as unknown as CubeMcp;
  const service = new McpService({ client, store: McpStore(CubeHome()), isBusy: () => false, beforePublish: async () => undefined });
  const login = await service.beginLogin("docs");
  const cancelled = service.cancelLogin("docs");
  await assert.rejects(login.completion, /cancelled/);
  assert.equal(service.isApplying(), true);
  await assert.rejects(service.restart("docs"), /current operation/);
  release(); await cancelled;
  assert.equal(service.isApplying(), false);
});
