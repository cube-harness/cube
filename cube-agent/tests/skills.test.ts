import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HomeManager as Home, WorkspaceManager } from "@cube/workspace";
import { MessageList, createSignal } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { createCubeSkills } from "../src/skills.js";
import { createSkillsProcessor, findSkillMentions } from "../src/processors/skills.processor.js";
import { resolveAgentSkills, createSkill } from "@mastra/core/skills";
import { InMemoryStore } from "@mastra/core/storage";
import { CubeContext } from "../src/context.js";
import { createContextProcessor } from "../src/processors/context.processor.js";

test("mentions exclude code, escapes, unknowns and partial names, preserving order", () => {
  const names = new Set(["review", "build"]);
  for (const [text, expected] of [
    ["Use $review $review then ($build).", ["review", "build"]],
    ["$PATH $unknown $ review $review-more \\$review", []],
    ["`$review` and ``a `$build` b`` $build", ["build"]],
    ["~~~ts\n$review\n~~~\n$build", ["build"]],
    ["```ts\n$review\n```\n$build", ["build"]],
    ["```ts\n$review", []],
  ] as const) assert.deepEqual(findSkillMentions(text, names), expected, text);
});

test("activation is atomic, keeps user input intact, deduplicates tool steps, and counts toward context", async () => {
  const enabled = resolveAgentSkills([createSkill({ name: "review", description: "Review", instructions: "Full instructions. ".repeat(10_000) })]);
  const snapshot = { catalog: ["review", "missing"].map((name) => ({ name, path: name, description: name,
    source: "project" as const, enabled: true, userInvocable: true })), projectPaths: [], globalPaths: [], enabled };
  const skills = { snapshot: async () => snapshot, list: async () => snapshot.catalog, setDisabled() {} };
  const processor = createSkillsProcessor(skills);
  const list = new MessageList({ threadId: "thread", resourceId: "resource" });
  list.add({ id: "submission", role: "user", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "$review $missing" }] } }, "input");
  const requestContext = new RequestContext();
  const sendSignal = async (input: Parameters<typeof createSignal>[0]) => {
    const signal = createSignal(input);
    list.addSignal(signal);
    return signal;
  };
  requestContext.set("controller", { threadId: "thread" });
  const failedState = {};
  await processor.processInput!({ messageList: list, requestContext, state: failedState, sendSignal } as any);
  assert.throws(() => processor.processLLMRequest!({ state: failedState } as any), /Cannot load skill/);
  assert.equal(list.get.input.db()[0]!.content.parts.length, 1);
  assert.equal(list.get.all.db().filter(message => message.role === "signal").length, 0);
  list.add({ ...list.get.input.db()[0]!, content: { format: 2, parts: [{ type: "text", text: "$review" }] } }, "input", { merge: false });
  const skillState = {};
  await processor.processInput!({ messageList: list, requestContext, state: skillState, sendSignal } as any);
  const before = structuredClone(list.get.input.db()[0]);
  await processor.processInputStep!({ messageList: list, requestContext, state: skillState, sendSignal } as any);
  assert.deepEqual(list.get.input.db()[0], before);
  assert.equal(before!.id, "submission");
  assert.equal(before!.content.parts.length, 1);
  assert.equal(list.get.all.db().filter(message => message.role === "signal").length, 1);
  const missingState = {};
  const fresh = new MessageList();
  fresh.add({ role: "user", content: "$review" }, "input");
  await processor.processInput!({ messageList: fresh, requestContext, state: missingState } as any);
  assert.throws(() => processor.processLLMRequest!({ state: missingState } as any), /native signal delivery/);
  const storage = new InMemoryStore();
  const memory = (await storage.getStore("memory"))!;
  await memory.saveThread({ thread: { id: "thread", resourceId: "resource", createdAt: new Date(), updatedAt: new Date() } });
  const context = new CubeContext({ policy: { manual_min_ratio: 0.3, keep_recent_ratio: 0.25, reserve_tokens: 1000 },
    storage: async () => memory, protectedTools: new Set(),
    summarize: async () => { assert.fail("no older history can be compacted"); },
  });
  const guard = createContextProcessor(context, async () => ({ limits: { context: 20_000 } }), () => "test");
  const state = {};
  await guard.processInputStep!({ messageList: list, state } as any);
  await assert.rejects(async () => guard.processLLMRequest!({ state, requestContext,
    prompt: await list.get.all.aiV5.llmPrompt(), abort: (reason: string) => { throw new Error(reason); },
  } as any), /No older conversation can be compacted safely/);
  assert.match(JSON.stringify(list.get.all.db()), /Full instructions/, "guard must not truncate the signal body");
});

test("partial skill delivery fails closed and retry uses persisted activation metadata", async () => {
  const enabled = resolveAgentSkills(["first", "second"].map(name => createSkill({ name, description: name, instructions: name })));
  const catalog = ["first", "second"].map(name => ({ name, path: name, description: name, source: "project" as const, enabled: true, userInvocable: true }));
  const processor = createSkillsProcessor({ snapshot: async () => ({ catalog, enabled, projectPaths: [], globalPaths: [] }), list: async () => catalog, setDisabled() {} });
  const list = new MessageList();
  list.add({ id: "trigger", role: "user", content: "$first $second" }, "input");
  let attempts = 0;
  const sendSignal = async (input: Parameters<typeof createSignal>[0]) => {
    if (++attempts === 2) throw new Error("Delivery failed");
    const signal = createSignal(input); list.addSignal(signal); return signal;
  };
  const failed = {};
  await processor.processInput!({ messageList: list, state: failed, sendSignal } as any);
  assert.throws(() => processor.processLLMRequest!({ state: failed } as any), /Delivery failed/);
  assert.equal(list.get.all.db().filter(message => message.role === "signal").length, 1);
  await processor.processInput!({ messageList: list, state: {}, sendSignal } as any);
  assert.equal(attempts, 3);
  assert.equal(list.get.all.db().filter(message => message.role === "signal").length, 2);
  assert.equal(list.get.input.db()[0]!.content.parts.length, 1);
});

test("catalog filters same-name sources and aliases; request snapshots and native path/search stay filtered", async () => {
  const root = await mkdtemp(join(tmpdir(), "cube-skills-"));
  try {
    const home = new Home({ cubeHome: join(root, "home"), userHome: root });
    const project = join(root, "project");
    const globalDir = join(home.getSkillDir(), "review");
    const projectDir = join(project, ".agents", "skills", "review");
    for (const [dir, body] of [[globalDir, "GLOBAL uniquegrape"], [projectDir, "PROJECT uniquebanana"]]) {
      await mkdir(dir!, { recursive: true });
      await writeFile(join(dir!, "SKILL.md"), `---\nname: review\ndescription: Review code\n---\n${body}`);
    }
    await mkdir(join(project, ".cube"), { recursive: true });
    await symlink(join(project, ".agents", "skills"), join(project, ".cube", "skills"), process.platform === "win32" ? "junction" : "dir");
    const skills = await createCubeSkills(home, new WorkspaceManager(home, project), []);
    const choices = await skills.list();
    assert.equal(choices.length, 2);
    const global = choices.find((choice) => choice.source === "global")!;
    const projectSkill = choices.find((choice) => choice.source === "project")!;
    const oldContext = new RequestContext();
    const old = await skills.snapshot(oldContext);
    assert.match((await old.enabled.get("review"))!.instructions, /GLOBAL/);
    skills.setDisabled([global.path]);
    assert.equal(await skills.snapshot(oldContext), old);
    const fresh = await skills.snapshot(new RequestContext());
    assert.match((await fresh.enabled.get("review"))!.instructions, /PROJECT/);
    assert.equal(await fresh.enabled.get(global.path), null);
    assert.deepEqual(await fresh.enabled.search("uniquegrape"), []);
    skills.setDisabled([global.path, projectSkill.path]);
    const empty = await skills.snapshot(new RequestContext());
    assert.deepEqual(await empty.enabled.list(), []);
    assert.equal(await empty.enabled.get(projectSkill.path), null);
    const processor = createSkillsProcessor(skills);
    const list = new MessageList();
    list.add({ role: "user", content: "$review" }, "input");
    const state = {};
    await processor.processInput!({ messageList: list, requestContext: new RequestContext(), state } as any);
    assert.throws(() => processor.processLLMRequest!({ state } as any), /disabled.*\/skills/);
    assert.equal(list.get.input.db()[0]!.content.parts.length, 1);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("community global skills share native loading, activation and disable filtering", async () => {
  const root = await mkdtemp(join(tmpdir(), "cube-community-skills-"));
  try {
    const home = new Home({ cubeHome: join(root, "home"), userHome: root });
    const project = join(root, "project");
    for (const [dir, name] of [
      [home.getSkillDir(), "cube-only"],
      [join(root, ".agents", "skills"), "community-review"],
      [join(project, ".agents", "skills"), "project-only"],
    ]) {
      await mkdir(join(dir!, name!), { recursive: true });
      await writeFile(join(dir!, name!, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill\n---\nInstructions for ${name}`);
    }
    const skills = await createCubeSkills(home, new WorkspaceManager(home, project), []);
    assert.deepEqual((await skills.list()).map(({ name, source }) => [name, source]), [
      ["community-review", "global"], ["cube-only", "global"], ["project-only", "project"],
    ]);
    const context = new RequestContext();
    const snapshot = await skills.snapshot(context);
    const community = snapshot.catalog.find(({ name }) => name === "community-review")!;
    assert.ok(snapshot.globalPaths.includes(community.path));
    const list = new MessageList();
    list.add({ role: "user", content: "Use $community-review" }, "input");
    await createSkillsProcessor(skills).processInput!({ messageList: list, requestContext: context, state: {},
      sendSignal: async (input: Parameters<typeof createSignal>[0]) => {
        const signal = createSignal(input); list.addSignal(signal); return signal;
      },
    } as any);
    assert.match(JSON.stringify(list.get.all.db()), /Instructions for community-review/);
    assert.doesNotMatch(JSON.stringify(list.get.input.db().filter(message => message.role === "user")), /Instructions for community-review/);
    skills.setDisabled([community.path]);
    const fresh = await skills.snapshot(new RequestContext());
    assert.equal(fresh.catalog.find(({ name }) => name === "community-review")!.enabled, false);
    assert.equal(await fresh.enabled.get(community.path), null);
    assert.equal(await skills.snapshot(context), snapshot);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
