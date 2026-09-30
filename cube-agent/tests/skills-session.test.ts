import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mastra } from "@mastra/core";
import { MessageList, isUserAuthoredMessage } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { MockLanguageModelV3 } from "ai/test";
import { HomeManager as Home, WorkspaceManager, createBootstrap, ConfigStore, RunnableConfigSchema } from "@cube/workspace";
import { createSkillsProcessor } from "../src/processors/skills.processor.js";
import { createCubeMastra, type CubeMastraComposition } from "../src/bootstrap.js";
import { toRuntimeNotice } from "../../cube-runtime/src/types.js";

test("native signals persist skill parts once; queues load at dispatch and stored history is not reread", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cube-skills-session-"));
  let mastra: Mastra | undefined;
  let composition: CubeMastraComposition | undefined;
  const release = Promise.withResolvers<void>();
  try {
    const project = join(root, "project");
    const skillDir = join(project, ".agents", "skills", "review");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: review\ndescription: Review code\n---\nUNIQUE LOADED INSTRUCTIONS");
    const home = new Home({ cubeHome: join(root, "home") });
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
          { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "done" }, { type: "text-end", id: "text" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
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
    skills.setDisabled((await skills.list()).map((skill) => skill.path));
    release.resolve();
    await ended.promise;
    await firstTurn;
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 2);
    assert.match(requests[0]!, /UNIQUE LOADED INSTRUCTIONS/);
    assert.doesNotMatch(requests[1]!, /cancel \$review/);
    assert.doesNotMatch(requests[1]!, /<name>review<\/name>/);
    const messages = await session.thread.listMessages({ threadId: "skill-thread" });
    const user = messages.filter(isUserAuthoredMessage).find((message) => message.content.metadata?.cube)!;
    assert.ok(user, "enrichment metadata must be stored in SQLite");
    assert.equal((user.content.metadata!.cube as any).displayText, "Use $review please");
    assert.equal(user.content.parts.filter((part) => part.type === "text" && part.text.includes("<skill_instructions")).length, 1);
    assert.ok(user.content.metadata!.signal, "native user signal metadata survives");
    const memory = await mastra.getStorage()!.getStore("memory");
    const restored = await memory!.listMessages({ threadId: "skill-thread", perPage: false });
    assert.deepEqual(restored.messages.find((message) => message.id === user.id)?.content, user.content);
    const cloned = await memory!.cloneThread({ sourceThreadId: "skill-thread", newThreadId: "skill-fork" });
    assert.deepEqual(cloned.clonedMessages.find((message) => message.content.metadata?.cube)?.content, user.content);
    // A fresh processor must not reinterpret stored mentions using changed preferences.
    const history = new MessageList();
    history.add(restored.messages, "memory");
    history.add({ role: "user", content: "continue again" }, "input");
    await createSkillsProcessor(skills).processInput!({ messageList: history, requestContext: new RequestContext(), state: {} } as any);
    assert.deepEqual(history.get.remembered.db().find((message) => message.id === user.id)?.content, user.content);
    await session.followUp({ content: "$review disabled" });
    assert.equal(requests.length, 2, "disabled activation must never reach the provider");
    assert.match(toRuntimeNotice((errors.at(-1) as any)?.error).message, /disabled.*\/skills/);
    skills.setDisabled([]);
    await session.followUp({ content: "$review again" });
    assert.equal(requests.length, 3);
    const repeated = await session.thread.listMessages({ threadId: "skill-thread" });
    assert.equal(repeated.filter((message) => (message.content.metadata?.cube as any)?.displayText === "$review again").length, 1);
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
  } finally {
    release.resolve();
    await composition?.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
