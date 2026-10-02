import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { ConfigStore, HomeManager, WorkspaceManager, RunnableConfigSchema, createBootstrap, createMemoryStore, type MemoryEntry } from "@cube/workspace";
import { createCubeMastra, type CubeMastraComposition } from "../src/bootstrap.js";
import { reloadCubeAgentInstructions } from "../src/agents/default.agent.js";
import { ThreadService } from "../../cube-runtime/src/services/thread.service.js";

test("runtime snapshots load at real thread creation and remain frozen until reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "cube-thread-context-"));
  let composition: CubeMastraComposition | undefined;
  try {
    const project = join(root, "project");
    await mkdir(project);
    const home = new HomeManager({ cubeHome: join(root, "home") });
    await createBootstrap(home).run();
    await writeFile(join(project, "AGENTS.md"), "Before app startup");
    const workspace = new WorkspaceManager(home, project);
    const config = RunnableConfigSchema.parse({ ...await ConfigStore(home).read(), gateway: "api_key/google", model: "google/test" });
    composition = await createCubeMastra(home, workspace, config, { deferInstructions: true });
    assert.equal(composition.agent.readInstructions().sources.length, 0, "startup must not load project instructions");
    const session = await composition.controller.createSession({ resourceId: project });
    const initialId = session.thread.getId();
    if (initialId) await session.thread.delete({ threadId: initialId });
    const thread = new ThreadService(session, {
      read: composition.agent.readInstructions,
      install: composition.agent.installInstructions,
      refresh: composition.agent.refreshInstructions,
      reload: (includeDiscovered) => reloadCubeAgentInstructions(composition!.agent, home, workspace, includeDiscovered),
    }, undefined, {
      fork: (id, title) => composition!.context.fork(id, title),
      invalidate: () => composition!.context.invalidate(),
      isBusy: () => false,
      drain: () => composition!.drain(),
    });
    await writeFile(join(project, "AGENTS.md"), "Present at real creation");
    await thread.ensureForPrompt("first");
    assert.match(JSON.stringify(composition.agent.readInstructions()), /Present at real creation/);
    await writeFile(join(project, "AGENTS.md"), "Changed while chatting");
    await thread.ensureForPrompt("second");
    assert.doesNotMatch(JSON.stringify(composition.agent.readInstructions()), /Changed while chatting/);
    await thread.reload();
    assert.match(JSON.stringify(composition.agent.readInstructions()), /Changed while chatting/);
    await writeFile(join(project, "AGENTS.md"), "Present at fork");
    await thread.fork();
    assert.match(JSON.stringify(composition.agent.readInstructions()), /Present at fork/);
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
  } finally {
    await composition?.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a rejected first provider request rolls back only its empty new thread", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cube-empty-thread-"));
  let composition: CubeMastraComposition | undefined;
  try {
    const home = new HomeManager({ cubeHome: root });
    await createBootstrap(home).run();
    const workspace = new WorkspaceManager(home, root);
    const parsed = await ConfigStore(home).read();
    const config = RunnableConfigSchema.parse({ ...parsed, gateway: "api_key/google", model: "google/test", memory: {
      ...parsed.memory, generate_title: { ...parsed.memory.generate_title, enabled: false },
    } });
    composition = await createCubeMastra(home, workspace, config);
    let reject = true;
    composition.agent.model = new MockLanguageModelV3({ doStream: async () => {
      if (reject) throw new APICallError({ message: "HTTP 426: Upgrade Required", statusCode: 426,
        url: "https://example.invalid", requestBodyValues: {}, isRetryable: false });
      return { stream: new ReadableStream({ start(stream) {
        for (const chunk of [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "done" },
          { type: "text-end", id: "answer" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          } },
        ]) stream.enqueue(chunk);
        stream.close();
      } }) };
    } });
    const session = await composition.controller.createSession({ resourceId: root });
    const initialId = session.thread.getId();
    if (initialId) await session.thread.delete({ threadId: initialId });
    const thread = new ThreadService(session, {
      read: composition.agent.readInstructions, install: composition.agent.installInstructions,
      refresh: composition.agent.refreshInstructions, reload: async () => undefined,
    }, undefined, { fork: (id, title) => composition!.context.fork(id, title),
      invalidate: () => composition!.context.invalidate(), isBusy: () => false,
      drain: () => composition!.drain(),
    });
    const failures: unknown[] = [];
    session.subscribe((event) => { if (event.type === "error") failures.push(event.error); });
    session.onBeforeAgentEnd(async (event) => {
      await thread.finishRun(event.reason);
    });
    const emptyId = await thread.ensureForPrompt("first rejected prompt");
    await session.followUp({ content: "first rejected prompt" });
    assert.ok(failures.length);
    assert.equal(thread.current(), null);
    assert.equal(await session.thread.getById({ threadId: emptyId }), null);
    assert.equal((await thread.list()).length, 0);
    reject = false;
    const keptId = await thread.ensureForPrompt("retry");
    assert.notEqual(keptId, emptyId);
    await session.followUp({ content: "retry" });
    const messages = await session.thread.listMessages({ threadId: keptId });
    assert.ok(messages.length);
    reject = true;
    await session.followUp({ content: "later request rejected" });
    assert.equal(thread.current(), keptId);
    assert.deepEqual(await session.thread.listMessages({ threadId: keptId }), messages);
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
  } finally {
    await composition?.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("native chat receives a frozen memory prefix only in requests and reload updates it explicitly", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cube-memory-prefix-"));
  let composition: CubeMastraComposition | undefined;
  try {
    const home = new HomeManager({ cubeHome: join(root, "home") });
    await createBootstrap(home).run();
    const project = join(root, "project");
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "Use public APIs.");
    const config = RunnableConfigSchema.parse({ ...await ConfigStore(home).read(), gateway: "api_key/google", model: "google/test" });
    const workspace = new WorkspaceManager(home, project);
    const store = createMemoryStore(home, project);
    const writeIndex = async (text: string) => {
      const index: MemoryEntry = { source_id: "index_project", source_type: "index", project_id: store.projectId, title: "Project",
        status: "user_stated", updated_at: new Date().toISOString(), revision: text, incorporated: {}, sections: [], body: text };
      await store.publish({ revision: (await store.read()).revision, replacements: { "memory_summary.md": [index] } }, new AbortController().signal);
    };
    composition = await createCubeMastra(home, workspace, config, { deferInstructions: true });
    const session = await composition.controller.createSession({ resourceId: project });
    const initial = session.thread.getId();
    if (initial) await session.thread.delete({ threadId: initial });
    const requests: any[][] = [];
    composition.agent.model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
      requests.push(prompt);
      return { stream: new ReadableStream({ start(stream) {
        for (const chunk of [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "Done" }, { type: "text-end", id: "answer" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 },
          } }]) stream.enqueue(chunk);
        stream.close();
      } }) };
    } });
    const thread = new ThreadService(session, { read: composition.agent.readInstructions,
      install: composition.agent.installInstructions, refresh: composition.agent.refreshInstructions,
      reload: include => reloadCubeAgentInstructions(composition!.agent, home, workspace, include) });
    await writeIndex("FIRST_INDEX");
    await thread.ensureForPrompt("first");
    await session.followUp({ content: "first" });
    await writeIndex("SECOND_INDEX");
    await thread.ensureForPrompt("second");
    await session.followUp({ content: "second" });
    assert.equal(requests.length, 2);
    const position = (request: any[]) => request.findIndex(message => JSON.stringify(message).includes("<durable_memory>"));
    assert.ok(position(requests[0]!) > 0);
    assert.equal(position(requests[0]!), position(requests[1]!));
    assert.match(JSON.stringify(requests[1]), /FIRST_INDEX/);
    assert.doesNotMatch(JSON.stringify(requests[1]), /SECOND_INDEX/);
    await thread.reload();
    await session.followUp({ content: "third" });
    assert.match(JSON.stringify(requests[2]), /SECOND_INDEX/);
    const originals = await session.thread.listMessages({ threadId: thread.current()! });
    assert.doesNotMatch(JSON.stringify(originals), /durable_memory|FIRST_INDEX|SECOND_INDEX/);
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
  } finally {
    await composition?.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
