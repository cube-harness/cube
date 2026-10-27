import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Mastra } from "@mastra/core";
import { MessageList, isUserAuthoredMessage } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { MockLanguageModelV3 } from "ai/test";
import { HomeManager as Home, WorkspaceManager, createBootstrap, ConfigStore, RunnableConfigSchema } from "@cube/workspace";
import { createSkillsProcessor } from "../src/processors/skills.processor.js";
import { createCubeMastra, type CubeMastraComposition } from "../src/bootstrap.js";
import { toRuntimeNotice } from "../../cube-runtime/src/types.js";
import { configureCubePermissions } from "../src/permission.js";

test("native reactive skill signals survive tool steps, SQLite restore/fork and dispatch-time queue filtering", { timeout: 30_000 }, async t => {
  const root = process.env.CUBE_SKILLS_TEST_ROOT ?? await mkdtemp(join(tmpdir(), "cube-skills-session-"));
  // Release native SQLite transaction handles before removing the fixture on Windows.
  if (process.platform === "win32" && !process.env.CUBE_SKILLS_TEST_ROOT) {
    try {
      const env = { ...process.env, CUBE_SKILLS_TEST_ROOT: root };
      delete env.NODE_TEST_CONTEXT;
      const result = await promisify(execFile)(process.execPath,
        ["--import", "tsx", "--test", import.meta.filename],
        { env, windowsHide: true, timeout: 25_000 });
      t.diagnostic(result.stdout);
      assert.match(result.stdout, /fail 0/);
      assert.equal(result.stderr, "");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    return;
  }
  let mastra: Mastra | undefined;
  let composition: CubeMastraComposition | undefined;
  const release = Promise.withResolvers<void>();
  try {
    const project = join(root, "project");
    const skillDir = join(project, ".agents", "skills", "review");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(project, "README.md"), "fixture project");
    await writeFile(join(project, "AGENTS.md"), "PROJECT_CONTEXT_SENTINEL");
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: review\ndescription: Review code\n---\nUNIQUE LOADED INSTRUCTIONS");
    const home = new Home({ cubeHome: join(root, "home"), userHome: root });
    await createBootstrap(home).run();
    const workspace = new WorkspaceManager(home, project);
    const requests: string[] = [];
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const errors: unknown[] = [];
    const model = new MockLanguageModelV3({ doStream: async (options) => {
      requests.push(JSON.stringify(options.prompt));
      if (requests.length === 1) { started.resolve(); await release.promise; }
      return { stream: new ReadableStream({ start(stream) {
        for (const part of [
          { type: "stream-start", warnings: [] },
          ...(requests.length === 1 ? [{ type: "tool-call", toolCallId: "read-project", toolName: "read_file", input: '{"path":"README.md"}' }] : [
            { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "done" }, { type: "text-end", id: "text" },
          ]),
          { type: "finish", finishReason: { unified: requests.length === 1 ? "tool-calls" : "stop", raw: requests.length === 1 ? "tool_calls" : "stop" }, usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          } },
        ]) stream.enqueue(part);
        stream.close();
      } }) };
    } });
    const config = RunnableConfigSchema.parse({ ...await ConfigStore(home).read(), gateway: "api_key/google", model: "google/test" });
    composition = await createCubeMastra(home, workspace, config);
    composition.agent.model = model;
    mastra = composition.mastra;
    const skills = composition.skills;
    const session = await composition.controller.createSession({ resourceId: "workspace" });
    await configureCubePermissions(session, { require_approval_for: [] });
    let completions = 0;
    session.subscribe((event) => {
      if (event.type === "error") { errors.push(event); started.reject(event.error); ended.reject(event.error); }
      if (event.type === "agent_end" && ++completions === 2) ended.resolve();
    });
    await session.thread.create({ id: "skill-thread" });
    const firstTurn = session.followUp({ content: "Use $review please" });
    await started.promise;
    await session.followUp({ content: "cancel $review" });
    session.followUps.dequeue();
    await session.followUp({ content: "continue" });
    skills.setDisabled((await skills.list()).map((skill) => skill.configKey));
    release.resolve();
    await ended.promise;
    await firstTurn;
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 3);
    for (const name of ["cube-background", "cube-delegation", "cube-docs", "cube-memory", "skill-creator"]) {
      assert.ok(requests[0]!.includes(`<name>${name}</name>`));
    }
    assert.doesNotMatch(requests[0]!, /# Cube Background Work/);
    const firstPrompt = JSON.parse(requests[0]!);
    const projectIndex = firstPrompt.findIndex((message: any) => JSON.stringify(message).includes("PROJECT_CONTEXT_SENTINEL"));
    const requestIndex = firstPrompt.findIndex((message: any) => JSON.stringify(message).includes("Use $review please"));
    assert.ok(projectIndex >= 0 && projectIndex < requestIndex);
    assert.equal(firstPrompt[0].role, "system");
    assert.match(firstPrompt[0].content, /Cube operating instructions/);
    assert.match(requests[0]!, /UNIQUE LOADED INSTRUCTIONS/);
    assert.equal((requests[1]!.match(/UNIQUE LOADED INSTRUCTIONS/g) ?? []).length, 1);
    assert.doesNotMatch(requests[2]!, /cancel \$review/);
    assert.doesNotMatch(requests[2]!, /<name>review<\/name>/);
    assert.doesNotMatch(requests[2]!, /<name>cube-background<\/name>/);
    assert.match(requests[2]!, /Cube operating instructions/);
    assert.match(requests[2]!, /Commands run on the host|NOT an OS sandbox/);
    const messages = await session.thread.listMessages({ threadId: "skill-thread" });
    const user = messages.filter(isUserAuthoredMessage)[0]!;
    assert.equal(user.content.parts.filter((part) => part.type === "text").map(part => part.text).join("\n"), "Use $review please");
    assert.equal(user.content.parts.filter((part) => part.type === "text" && part.text.includes("<skill_instructions")).length, 0);
    const activations = messages.filter(message => (message.content.metadata?.signal as any)?.metadata?.cube?.kind === "skill-activation");
    assert.equal(activations.length, 1);
    const activation = activations[0]!;
    assert.equal((activation.content.metadata?.signal as any)?.type, "reactive");
    assert.equal((activation.content.metadata?.signal as any)?.tagName, "system-reminder");
    assert.equal((activation.content.metadata?.signal as any)?.metadata?.cube?.triggerMessageId, user.id);
    assert.match(JSON.stringify(activation.content), /UNIQUE LOADED INSTRUCTIONS/);
    assert.ok(user.content.metadata!.signal, "native user signal metadata survives");
    const memory = await mastra.getStorage()!.getStore("memory");
    const restored = await memory!.listMessages({ threadId: "skill-thread", perPage: false });
    assert.deepEqual(restored.messages.find((message) => message.id === user.id)?.content, user.content);
    assert.deepEqual(restored.messages.find(message => message.id === activation.id)?.content, activation.content);
    const cloned = await memory!.cloneThread({ sourceThreadId: "skill-thread", newThreadId: "skill-fork" });
    assert.deepEqual(cloned.clonedMessages.find((message) => (message.content.metadata?.signal as any)?.metadata?.cube?.kind === "skill-activation")?.content, activation.content);
    // A fresh processor must not reinterpret stored mentions using changed preferences.
    const history = new MessageList();
    history.add(restored.messages, "memory");
    history.add({ role: "user", content: "continue again" }, "input");
    await createSkillsProcessor(skills).processInput!({ messageList: history, requestContext: new RequestContext(), state: {} } as any);
    assert.deepEqual(history.get.remembered.db().find((message) => message.id === user.id)?.content, user.content);
    await session.followUp({ content: "$review disabled" });
    assert.equal(requests.length, 3, "disabled activation must never reach the provider");
    assert.match(toRuntimeNotice((errors.at(-1) as any)?.error).message, /disabled.*\/skills/);
    skills.setDisabled([]);
    await session.followUp({ content: "$review again" });
    assert.equal(requests.length, 4);
    const repeated = await session.thread.listMessages({ threadId: "skill-thread" });
    assert.equal(repeated.filter((message) => (message.content.metadata?.signal as any)?.metadata?.cube?.kind === "skill-activation").length, 2);
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
  } finally {
    release.resolve();
    await composition?.shutdown();
    if (!process.env.CUBE_SKILLS_TEST_ROOT)
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
