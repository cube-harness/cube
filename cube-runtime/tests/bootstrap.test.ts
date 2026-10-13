import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
const { RequestContext } = createRequire(import.meta.resolve("@cube/agent"))("@mastra/core/request-context");
import {
  AuthStore,
  Bootstrap,
  ConfigStore,
  CubeWorkspace,
  PermissionStore,
  HomeManager,
  ModelCatalogStore,
  ModelManager,
  Store,
  createBootstrap,
  type ModelCatalog,
} from "@cube/workspace";
import { prepareCubeRuntime } from "../src/bootstrap.js";

const modelId = "google/gemini-test";
const catalog: ModelCatalog = {
  updatedAt: new Date().toISOString(),
  providers: {
    google: {
      name: "Google",
      models: [{
        modelId,
        name: "Gemini Test",
        reasoning: false,
        tool_call: true,
        structured_output: true,
        attachment: false,
        open_weights: false,
        limit: { context: 128_000, output: 8_192 },
        modalities: { input: ["text"], output: ["text"] },
      }],
    },
  },
};

const withHome = async (run: (home: HomeManager) => Promise<void>) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cube-bootstrap-"));
  const home = new HomeManager({ cubeHome: directory });
  const canonical = new ModelManager(home, async () => ({ google: {
    name: "Google", models: { "gemini-test": catalog.providers.google!.models[0]! },
  } }));
  const originalPreview = ModelManager.prototype.preview;
  const preview = mock.method(ModelManager.prototype, "preview", (...args: Parameters<ModelManager["preview"]>) =>
    originalPreview.apply(canonical, args));
  try {
    await createBootstrap(home).run();
    await CubeWorkspace(home, process.env.INIT_CWD || process.cwd()).setTrust(true);
    await ModelCatalogStore(home).write({ api_key: {}, oauth: {}, local: {} });
    await run(home);
  } finally {
    preview.mock.restore();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};

const noProviderFetch: typeof fetch = async () => { assert.fail("API-key setup must not call the provider"); };

test("bootstrap skips onboarding for complete API-key config without probing the provider", async () => {
  await withHome(async (home) => {
    await new AuthStore(home).replaceApiKey("google", "test-key");
    await ConfigStore(home).update((config) => ({
      ...config,
      gateway: "api_key/google",
      model: modelId,
    }));

    const bootstrap = await prepareCubeRuntime({ home, fetch: noProviderFetch });

    assert.deepEqual(bootstrap.readiness, {
      ready: true,
      gatewayId: "api_key/google",
      model: { modelId },
    });
    assert.equal(bootstrap.workspaceRoot.length > 0, true);
  });
});

test("bootstrap never infers or rewrites a gateway from model and credentials", async () => {
  await withHome(async (home) => {
    await new AuthStore(home).replaceApiKey("google", "test-key");
    await ConfigStore(home).update(config => ({ ...config, gateway: undefined, model: modelId }));
    const before = await readFile(home.getConfigPath(), "utf8");
    const bootstrap = await prepareCubeRuntime({ home, fetch: noProviderFetch });
    assert.equal(bootstrap.readiness.ready, false);
    assert.equal(await readFile(home.getConfigPath(), "utf8"), before);
  });
});

test("bootstrap reports invalid config without rewriting the file or leaking its contents", async () => {
  await withHome(async home => {
    await new Store(home.getConfigPath(), "yaml").write({ unexpected: "private-content" });
    const before = await readFile(home.getConfigPath(), "utf8");
    await assert.rejects(() => prepareCubeRuntime({ home, fetch: noProviderFetch }),
      (error: unknown) => error instanceof Error && /Invalid config.yaml/.test(error.message)
        && !error.message.includes("private-content"));
    assert.equal(await readFile(home.getConfigPath(), "utf8"), before);
  });
});

test("bootstrap requires onboarding when gateway configuration is incomplete", async () => {
  await withHome(async (home) => {
    const bootstrap = await prepareCubeRuntime({ home, fetch: noProviderFetch });
    assert.equal(bootstrap.readiness.ready, false);
  });
});

test("a selected local gateway uses its default endpoint without rewriting minimal YAML", async () => {
  await withHome(async (home) => {
    await new Store(home.getConfigPath(), "yaml").write({ gateway: "local/ollama", model: "ollama/test-local" });
    const before = await readFile(home.getConfigPath(), "utf8");
    const bootstrap = await prepareCubeRuntime({ home, fetch: async (url) => {
      assert.equal(String(url), "http://127.0.0.1:11434/api/tags");
      return Response.json({ models: [{ name: "test-local" }] });
    } });
    assert.equal(bootstrap.readiness.ready, true);
    assert.equal(await readFile(home.getConfigPath(), "utf8"), before);
  });
});

test("bootstrap detects missing keys, unavailable models, and unreachable local gateways", async () => {
  const cases = [
    { gateway: "api_key/google" as const, model: modelId },
    { gateway: "api_key/google" as const, model: "google/missing", key: "test-key" },
    { gateway: "local/ollama" as const, model: "ollama/test" },
  ];

  for (const item of cases) {
    await withHome(async (home) => {
      if (item.key) await new AuthStore(home).replaceApiKey("google", item.key);
      await ConfigStore(home).update((config) => ({
        ...config,
        gateway: item.gateway,
        model: item.model,
      }));
      const bootstrap = await prepareCubeRuntime({
        home,
        fetch: item.gateway === "local/ollama"
          ? async () => { throw new Error("offline"); }
          : noProviderFetch,
      });
      assert.equal(bootstrap.readiness.ready, false, item.gateway);
    });
  }
});

test("start rechecks readiness before constructing the runtime", async () => {
  await withHome(async (home) => {
    await new AuthStore(home).replaceApiKey("google", "test-key");
    await ConfigStore(home).update((config) => ({
      ...config,
      gateway: "api_key/google",
      model: modelId,
    }));
    const bootstrap = await prepareCubeRuntime({ home, fetch: noProviderFetch });
    await ConfigStore(home).update((config) => ({ ...config, model: undefined }));

    await assert.rejects(() => bootstrap.start(), /Choose a gateway and model/);
  });
});

test("startup reuses prepared resources and reads the committed model", { timeout: 30_000 }, async (context) => {
  await withHome(async home => {
    context.mock.method(home, "getMemoryDbPath", () => ":memory:");
    const run = context.mock.method(Bootstrap.prototype, "run");
    const workspacePath = path.join(home.getRoot(), "project");
    await mkdir(workspacePath);
    await writeFile(path.join(workspacePath, "AGENTS.md"), "Loaded at app startup");
    const prepared = await prepareCubeRuntime({ home, workspacePath,
      fetch: async (url, init) => String(url).endsWith("/api/tags")
        ? Response.json({ models: [{ name: "test-local" }] })
        : String(url).startsWith("https://cli-chat-proxy.grok.com/")
          ? Response.json({ data: [{ id: "grok-build" }] })
          : String(url).startsWith("https://chatgpt.com/backend-api/codex/models")
            ? Response.json({ models: [{ slug: "account-only-integration-model" }] })
            : noProviderFetch(url, init),
    });
    await prepared.setTrust(true);
    await PermissionStore(home).update((registry) => ({ workspaces: registry.workspaces.map((entry) =>
      entry.path === workspacePath ? { ...entry, permissions: { workspace_only: false, require_approval_for: [] } } : entry) }));
    assert.equal(prepared.readiness.ready, false);
    const draft = await prepared.gateway.createApiKeyDraft("api_key/google", "test-key");
    await prepared.gateway.commitInitial({ draftId: draft.draftId, model: { modelId } });
    await ConfigStore(home).update(config => ({ ...config, telemetry: false,
      memory: { ...config.memory,
        generate_title: { ...config.memory.generate_title, enabled: false },
      },
    }));
    const runtime = await prepared.start();
    try {
      assert.equal(runtime.thread.current(), null, "loading context must not create a thread");
      const loadedInfo = runtime.getInstructionInfo();
      assert.ok(loadedInfo.soulCharacters > 0, "SOUL must be loaded before the first prompt");
      assert.equal(loadedInfo.agentsFiles, 1);
      await writeFile(path.join(workspacePath, "AGENTS.md"), "Changed before first prompt");
      const preservedThread = await runtime.thread.ensureForPrompt("Preserved conversation");
      assert.deepEqual(runtime.getInstructionInfo(), loadedInfo, "first prompt must reuse the startup snapshot");
      assert.equal(run.mock.callCount(), 1, "start must not bootstrap the home again");
      assert.equal(runtime.gateway, prepared.gateway);
      assert.equal(runtime.model.current().modelId, modelId);
      assert.equal(prepared.readiness.ready, true);
      assert.equal((await runtime.gateway.listModels()).providers.google?.models[0]?.modelId, modelId);
      await new AuthStore(home).update(auth => ({ ...auth, oauth: { ...auth.oauth,
        xai: { access_token: "grok-test", refresh_token: "grok-refresh", expires_at: Date.now() + 3600000 },
      } }));
      const grok = await runtime.gateway.createStoredDraft("oauth/xai");
      // Use the real Session gate to exercise the runtime's live-switch boundary.
      const session = (runtime as unknown as { dependencies: { session: import("@cube/agent").Session } }).dependencies.session;
      const tools = (runtime as unknown as { dependencies: { tools: import("@cube/agent").CubeTools } }).dependencies.tools;
      const management = tools.forModel(modelId);
      const caller = { agent: { threadId: "runtime-owner" } } as never;
      assert.deepEqual(await management.manage_task.execute!({ action: "list" } as never, caller), { tasks: [] });
      assert.deepEqual(await management.manage_subagent.execute!({ action: "list" } as never, caller), { subagents: [] });
      const unknownJob = "00000000-0000-4000-8000-000000000000";
      await assert.rejects(management.manage_task.execute!({ action: "get", id: unknownJob } as never, caller), /Unknown.*(?:process|output)/);
      await assert.rejects(management.manage_subagent.execute!({ action: "get", id: unknownJob } as never, caller), /Unknown or unavailable subagent/);
      const externalPath = path.join(home.getRoot(), "external.txt");
      await writeFile(externalPath, "external fixture");
      const filesystem = await session.getWorkspace()!.resolveFilesystem({ requestContext: new RequestContext() });
      assert.equal(String(await filesystem!.readFile(externalPath)), "external fixture");
      const write = tools.forModel(modelId).write_file!;
      const output = await write.execute!({ path: externalPath, content: "updated", overwrite: true }, {} as never) as any;
      assert.equal(output.status, "applied", "workspace override must reach custom tools");
      assert.equal(session.permissions.getRules().tools?.write_file, "allow");
      assert.equal("permissions" in await ConfigStore(home).read(), false, "workspace policies must not be written into global config");
      const permissions = await runtime.prompt.submit("/permissions");
      assert.equal(permissions.kind, "permissions");
      assert.ok(runtime.suggestions.some((item) => item.name === "/permissions"));
      if (permissions.kind !== "permissions") throw new Error("Expected permission picker");
      const draftPermissions = permissions.permissions;
      for (const name of ["execute_command", "edit_file", "write_file", "apply_patch", "read_file", "list_files", "ask_user", "manage_task", "manage_subagent"])
        assert.ok(Object.hasOwn(draftPermissions.tools, name), `missing permission row: ${name}`);
      draftPermissions.workspaceOnly = true;
      draftPermissions.tools.read_file = "deny";
      draftPermissions.tools.write_file = "ask";
      await runtime.permission.set(draftPermissions);
      assert.equal(runtime.thread.current(), preservedThread, "Apply must not recreate the thread");
      assert.deepEqual(runtime.getInstructionInfo(), loadedInfo, "Apply must not reload project context");
      assert.equal(session.resolveToolApproval("read_file"), "deny");
      assert.equal(session.resolveToolApproval("write_file"), "ask");
      const restrictedFs = await session.getWorkspace()!.resolveFilesystem({ requestContext: new RequestContext() });
      await assert.rejects(restrictedFs!.readFile(externalPath), /Permission denied/);
      assert.equal((await write.execute!({ path: externalPath, content: "not allowed", overwrite: true }, {} as never) as any).status, "failed");
      const approval = session.approval.arm({ toolName: "execute_command", toolCallId: "gate" });
      await assert.rejects(runtime.permission.set(draftPermissions), /Finish or cancel/);
      await assert.rejects(runtime.gateway.set({ draftId: grok.draftId, model: { modelId: "xai/grok-build" } }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /rollback failed/);
        assert.match(String(error.cause), /Finish or cancel/);
        return true;
      });
      assert.equal(runtime.model.current().modelId, modelId);
      assert.equal((await ConfigStore(home).read()).gateway, "api_key/google");
      runtime.respondToApproval({ toolName: "execute_command", toolCallId: "gate", decision: "decline" });
      await approval;
      session.approval.clearToolName();
      draftPermissions.workspaceOnly = false;
      draftPermissions.tools.read_file = "allow";
      draftPermissions.tools.write_file = "allow";
      await runtime.permission.set(draftPermissions);
      assert.equal(session.resolveToolApproval("read_file"), "allow");
      const reopenedFs = await session.getWorkspace()!.resolveFilesystem({ requestContext: new RequestContext() });
      assert.equal(String(await reopenedFs!.readFile(externalPath)), "updated");
      const grokRetry = await runtime.gateway.createStoredDraft("oauth/xai");
      await runtime.gateway.set({ draftId: grokRetry.draftId, model: { modelId: "xai/grok-build" } });
      assert.equal(runtime.model.current().modelId, "xai/grok-build");
      assert.equal((await ConfigStore(home).read()).gateway, "oauth/xai");
      assert.equal((await runtime.gateway.listModels()).providers.xai?.models[0]?.tool_call, undefined);
      assert.equal((await runtime.gateway.readiness()).ready, true);
      await new AuthStore(home).update(auth => ({ ...auth, oauth: { ...auth.oauth,
        openai: { access_token: "openai-test", refresh_token: "openai-refresh",
          account_id: "integration-account", expires_at: Date.now() + 3600000 },
      } }));
      const openai = await runtime.gateway.createStoredDraft("oauth/openai");
      await runtime.gateway.set({ draftId: openai.draftId, model: { modelId: "openai/account-only-integration-model" } });
      assert.equal(runtime.model.current().modelId, "openai/account-only-integration-model");
      const local = await runtime.gateway.createLocalDraft("local/ollama", "http://127.0.0.1:11435");
      await runtime.gateway.set({ draftId: local.draftId, model: { modelId: "ollama/test-local" } });
      assert.equal(runtime.model.current().modelId, "ollama/test-local");
      assert.equal((await ConfigStore(home).read()).gateway, "local/ollama");
      const api = await runtime.gateway.createStoredDraft("api_key/google");
      await runtime.gateway.set({ draftId: api.draftId, model: { modelId } });
      const cache = await ModelCatalogStore(home).read();
      assert.ok(cache.api_key.google && cache.oauth.openai && cache.oauth.xai && cache.local.ollama);
      const removed = await runtime.gateway.removeCredential("oauth/openai");
      assert.equal(removed.active, false);
      assert.equal(removed.cacheCleared, true);
      assert.equal((await ModelCatalogStore(home).read()).oauth.openai, undefined);
      assert.deepEqual((await ModelCatalogStore(home).read()).oauth.xai, cache.oauth.xai);
      assert.ok((await ModelCatalogStore(home).read()).api_key.google);
      await runtime.gateway.removeCredential("api_key/google");
      assert.equal((await runtime.gateway.readiness()).ready, false);
      assert.equal((await runtime.prompt.submit("must not reach inference")).kind, "gateways");
      const restored = await runtime.gateway.createApiKeyDraft("api_key/google", "replacement-key");
      await runtime.gateway.set({ draftId: restored.draftId, model: { modelId } });
      assert.equal((await runtime.gateway.readiness()).ready, true);
      assert.equal(runtime.thread.current(), preservedThread);
    } finally { await runtime.shutdown(); }
  });
});

test("workspace trust is persisted and checked before runtime startup or provider discovery", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cube-trust-"));
  const home = new HomeManager({ cubeHome: directory });
  const prepare = () => prepareCubeRuntime({ home, workspacePath: directory, fetch: noProviderFetch });
  try {
    const first = await prepare();
    assert.equal(first.permission, undefined);
    await assert.rejects(first.start(), /not trusted/);
    const initialBytes = await readFile(home.getPermissionPath(), "utf8");
    await first.setTrust(false);
    assert.equal(await readFile(home.getPermissionPath(), "utf8"), initialBytes);
    const rejected = await prepare();
    assert.equal(rejected.permission, undefined);
    await assert.rejects(rejected.start(), /not trusted/);
    await rejected.setTrust(true);
    const accepted = await prepare();
    assert.equal(accepted.permission?.trusted, true);
    assert.deepEqual(accepted.permission?.permissions, {
      workspace_only: true,
      require_approval_for: ["execute_command", "edit_file", "write_file", "apply_patch"],
      deny_for: [],
      allow_for: [],
    }, "trust must persist editable defaults for this workspace");
    const registry = await PermissionStore(home).read();
    assert.equal(registry.workspaces.length, 1);
    assert.equal(registry.workspaces[0]?.path, directory);
    // Revoking trust between prepare and start must also block the engine.
    await PermissionStore(home).write({ workspaces: [] });
    await assert.rejects(accepted.start(), /not trusted/);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
