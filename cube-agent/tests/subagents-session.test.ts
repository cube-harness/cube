import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MockLanguageModelV3 } from "ai/test";
import { HomeManager, WorkspaceManager, RunnableConfigSchema, AuthStore, parseMcpConfig } from "@cube/workspace";
import { createSubagentChild, subagentAllowsTool, type SubagentChild, type CreateSubagentChildOptions } from "../src/agents/subagent.agent.js";
import { MCPClient } from "@mastra/mcp";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { CubeMcp } from "../src/mcp/client.js";
import { CubeContext } from "../src/context.js";
import { createCubeSkills } from "../src/skills.js";
import type { MemoryStorage } from "@mastra/core/storage";

test("child Session executes isolated history and approval without title or semantic model calls", { timeout: 20000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cube-child-session-"));
  const home = new HomeManager({ cubeHome: path.join(temp, "home"), userHome: temp });
  await home.ensure();
  const config = RunnableConfigSchema.parse({ gateway: "api_key/google", model: "google/test" });
  const definition = { name: "worker", description: "test worker", instructions: "Do the task", source: "builtin" as const };
  const prompts: unknown[] = [];
  const exposed: string[][] = [];
  let readStorage!: () => Promise<MemoryStorage>;
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async ({ prompt, tools }) => {
    prompts.push(prompt);
    exposed.push((tools ?? []).map(tool => tool.name));
    const turn = calls++;
    return { stream: new ReadableStream({ start(stream) {
      stream.enqueue({ type: "stream-start", warnings: [] });
      if (turn === 0 || turn === 3) stream.enqueue({ type: "tool-call", toolCallId: turn === 0 ? "same-call" : "question-call", toolName: turn === 0 ? "write_file" : "ask_user",
        input: JSON.stringify(turn === 0 ? { path: "child.txt", content: "child content" } : { question: "Continue?" }) });
      else if (turn === 1 || turn === 4) {
        stream.enqueue({ type: "text-start", id: "reply" });
        stream.enqueue({ type: "text-delta", id: "reply", delta: turn === 1 ? "Changed child.txt; verified by readback." : "Question cancelled; continuing normally." });
        stream.enqueue({ type: "text-end", id: "reply" });
      }
      stream.enqueue({ type: "finish", finishReason: { unified: turn === 0 || turn === 3 ? "tool-calls" : "stop", raw: turn === 0 || turn === 3 ? "tool_calls" : "stop" },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } });
      stream.close();
    } }) };
  } });
  const child = await createSubagentChild({ id: randomUUID(), projectRoot: temp, executionRoot: temp, cwd: temp,
    definition, modelId: "google/test", instructions: { soul: "Cube test", sources: [], explored: [] },
    readPermissions: () => config.permissions, home, config, gateways: [],
    skills: await createCubeSkills(home, new WorkspaceManager(home, temp), []),
    mcp: { readTools: () => ({}), readToolNames: () => [] }, readModel: async () => ({ limits: { context: 100000, output: 4096 } }),
    createContext: (_agent, storage) => {
      readStorage = storage;
      return new CubeContext({ storage, policy: config.memory.compaction,
        protectedTools: new Set(), summarize: async () => { throw new Error("No compact expected"); } });
    },
  });
  child.agent.model = model;
  let approvals = 0;
  let cancelled: Promise<void> | undefined;
  const stop = child.session.subscribe(event => {
    if (event.type === "tool_approval_required") {
      approvals++;
      child.session.respondToToolApproval({ toolCallId: event.toolCallId, decision: "approve" });
    }
    if (event.type === "tool_suspended" && event.toolName === "ask_user")
      cancelled = child.session.respondToToolSuspension({ toolCallId: event.toolCallId, resumeData: { cancelled: true } });
  });
  try {
    await child.session.thread.create({ id: child.session.identity.getId(), title: "Assigned task" });
    const result = await child.run("Write child.txt");
    assert.equal(result.status, "completed");
    assert.equal(result.text, "Changed child.txt; verified by readback.");
    assert.equal(await readFile(path.join(temp, "child.txt"), "utf8"), "child content");
    assert.equal(approvals, 1);
    assert.equal(calls, 2);
    assert.match(JSON.stringify(prompts[0]), /Write child.txt/);
    assert.doesNotMatch(JSON.stringify(prompts[0]), /parent secret conversation/);
    assert.ok(exposed.every(tools => !tools.some(name => /spawn_agent|subagent$/.test(name))));
    const empty = await child.run("Return nothing");
    assert.equal(empty.text, "", "an empty new response must not reuse an older report");
    assert.equal(empty.status, "failed", "no final report must not advance a dependent chain");
    assert.notEqual(empty.runId, result.runId);
    const question = await child.run("Ask one question; continue after cancellation");
    await cancelled;
    assert.equal(question.status, "completed");
    assert.match(JSON.stringify(prompts.at(-1)), /User declined to answer the question/);
    const stored = await (await readStorage()).listMessages({ threadId: child.session.identity.getId(), resourceId: temp,
      perPage: 100, page: 0, orderBy: { field: "createdAt", direction: "ASC" } });
    assert.match(JSON.stringify(stored.messages), /User declined to answer the question/);
  } finally {
    stop();
    await child.dispose();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("child tool policy never exposes delegation and explore/custom policy narrows final tools", () => {
  const explore = { name: "explore", source: "builtin" as const, description: "inspect", instructions: "inspect" };
  assert.equal(subagentAllowsTool(explore, "write_file"), false);
  assert.equal(subagentAllowsTool(explore, "spawn_agent"), false);
  assert.equal(subagentAllowsTool(explore, "read_file"), true);
  assert.equal(subagentAllowsTool({ ...explore, name: "custom", tools: ["read_file"] }, "execute_command"), false);
  assert.equal(subagentAllowsTool({ ...explore, name: "custom", tools: ["read_file"], disallowedTools: ["read_file"] }, "controllerBuiltIn.read_file"), false);
  assert.equal(subagentAllowsTool({ ...explore, name: "custom", disallowedTools: ["execute_command"] }, "read_file"), true);
  assert.equal(subagentAllowsTool({ ...explore, name: "custom", disallowedTools: ["execute_command"] }, "execute_command"), false);
  assert.equal(subagentAllowsTool({ ...explore, name: "custom", tools: [] }, "read_file"), false);
});

test("child skill/server scopes reach native tools and model input without preloading or changing parent", { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-child-scopes-"));
  const home = new HomeManager({ cubeHome: path.join(root, "home"), userHome: root });
  await home.ensure();
  const blockedPath = path.join(home.getSkillDir(), "blocked", "SKILL.md");
  const allowedDir = path.join(root, ".agents", "skills", "allowed");
  await mkdir(path.dirname(blockedPath), { recursive: true });
  await mkdir(path.join(allowedDir, "references"), { recursive: true });
  await writeFile(blockedPath, "---\nname: blocked\ndescription: Blocked skill\n---\nBLOCKED_SECRET_BODY");
  await writeFile(path.join(allowedDir, "SKILL.md"), "---\nname: allowed\ndescription: Allowed skill\n---\nALLOWED_BODY");
  await writeFile(path.join(allowedDir, "references", "check.md"), "ALLOWED_REFERENCE");
  const skills = await createCubeSkills(home, new WorkspaceManager(home, root), []);
  const mcp = new CubeMcp({ auth: new AuthStore(home), workspaceRoot: root });
  const tool = createTool({ id: "lookup", description: "Lookup", inputSchema: z.object({}), execute: async () => "MCP_RESULT" });
  let discovery = 0;
  t.mock.method(MCPClient.prototype, "listToolsWithErrors", async () => ({
    tools: discovery++ === 0 ? { remote_lookup: tool } : { other_lookup: tool }, errors: {}, errorDetails: {},
  }));
  t.mock.method(MCPClient.prototype, "disconnect", async () => undefined);
  const config = RunnableConfigSchema.parse({ gateway: "api_key/google", model: "google/test" });
  const options: CreateSubagentChildOptions = {
    id: randomUUID(), projectRoot: root, executionRoot: root, cwd: root,
    definition: { name: "worker", description: "scoped", instructions: "Do the task", source: "builtin",
      skills: ["allowed"], mcpServers: ["docs"], disallowedTools: ["read_file", "ask_user"] },
    modelId: "google/test", instructions: { soul: "Cube test", sources: [], explored: [] },
    readPermissions: () => config.permissions, home, config, gateways: [], skills, mcp,
    readModel: async () => ({ limits: { context: 100000, output: 4096 } }),
    createContext: (_agent, storage) => new CubeContext({ storage, policy: config.memory.compaction,
      protectedTools: new Set(), summarize: async () => { throw new Error("No compact expected"); } }),
  };
  let child: SubagentChild | undefined;
  try {
    await mcp.reload(parseMcpConfig({ mcpServers: { docs: { command: "node" }, other: { command: "node" } } }), async () => undefined);
    await assert.rejects(createSubagentChild({ ...options, definition: { ...options.definition, skills: ["missing"] } }), /Unavailable child skill/);
    await assert.rejects(createSubagentChild({ ...options, definition: { ...options.definition, mcpServers: ["missing"] } }), /no longer configured/);
    child = await createSubagentChild(options);
    const requests: string[] = [];
    const exposed: string[][] = [];
    child.agent.model = new MockLanguageModelV3({ doStream: async ({ prompt, tools }) => {
      requests.push(JSON.stringify(prompt));
      exposed.push((tools ?? []).map(tool => tool.name));
      const first = requests.length === 1;
      return { stream: new ReadableStream({ start(stream) {
        stream.enqueue({ type: "stream-start", warnings: [] });
        if (first) {
          for (const [id, name, input] of [
            ["load", "skill", { name: "allowed" }],
            ["reference", "skill_read", { skillName: "allowed", path: "references/check.md" }],
            ["blocked", "skill_read", { skillName: blockedPath, path: "SKILL.md" }],
            ["search", "skill_search", { query: "BLOCKED_SECRET_BODY" }],
          ] as const) stream.enqueue({ type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) });
        } else {
          stream.enqueue({ type: "text-start", id: "reply" });
          stream.enqueue({ type: "text-delta", id: "reply", delta: "Scoped task complete." });
          stream.enqueue({ type: "text-end", id: "reply" });
        }
        stream.enqueue({ type: "finish", finishReason: { unified: first ? "tool-calls" : "stop", raw: first ? "tool_calls" : "stop" },
          usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } });
        stream.close();
      } }) };
    } });
    await child.session.thread.create({ id: options.id });
    const result = await child.run("Inspect the permitted skill using its native tools.");
    assert.equal(result.status, "completed", result.error);
    assert.equal(requests.length, 2);
    assert.match(requests[0]!, /<name>allowed<\/name>/);
    assert.doesNotMatch(requests[0]!, /<name>blocked<\/name>|ALLOWED_BODY|BLOCKED_SECRET_BODY/);
    assert.match(requests[1]!, /ALLOWED_BODY/);
    assert.match(requests[1]!, /ALLOWED_REFERENCE/);
    const toolResults = JSON.stringify(JSON.parse(requests[1]!)
      .filter((message: { role: string }) => message.role === "tool")
      .flatMap((message: { content: { output: unknown }[] }) => message.content.map(part => part.output)));
    assert.doesNotMatch(toolResults, /BLOCKED_SECRET_BODY/, "search query may be retained, but excluded skill content must not be returned");
    assert.match(requests[1]!, /not found|No results found/);
    assert.ok(exposed.every(names => names.includes("remote_lookup") && !names.includes("other_lookup") && !names.includes("read_file") && !names.includes("ask_user")));
    assert.deepEqual((await skills.list()).map(skill => skill.name), ["allowed", "blocked"]);
    assert.deepEqual(mcp.readToolNames(), ["other_lookup", "remote_lookup"]);
  } finally {
    await child?.dispose(); await mcp.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("two real child Sessions keep identical call IDs, approvals and history private", { timeout: 60000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cube-child-gates-"));
  const home = new HomeManager({ cubeHome: path.join(temp, "home"), userHome: temp });
  await home.ensure();
  await writeFile(path.join(temp, "fixture.txt"), "READ_EVIDENCE");
  const config = RunnableConfigSchema.parse({ gateway: "api_key/google", model: "google/test",
    permissions: { require_approval_for: ["read_file"] } });
  const skills = await createCubeSkills(home, new WorkspaceManager(home, temp), []);
  const children: SubagentChild[] = [];
  const approvals = new Map<string, string>();
  const prompts = new Map<string, unknown[]>();
  const exposed: string[][] = [];
  try {
    for (const name of ["first", "second"]) {
      const child = await createSubagentChild({ id: randomUUID(), projectRoot: temp, executionRoot: temp, cwd: temp,
        definition: { name, description: name, instructions: "Inspect", source: "builtin", tools: ["read_file"] },
        modelId: "google/test", instructions: { soul: "Cube", sources: [], explored: [] },
        home, config, readPermissions: () => config.permissions, gateways: [], skills,
        mcp: { readTools: () => ({}), readToolNames: () => [] }, readModel: async () => ({ limits: { context: 100000, output: 4096 } }),
        createContext: (_agent, storage) => new CubeContext({ storage, policy: config.memory.compaction,
          protectedTools: new Set(), summarize: async () => { throw new Error("No compact expected"); } }),
      });
      children.push(child);
      let calls = 0;
      prompts.set(name, []);
      child.agent.model = new MockLanguageModelV3({ doStream: async ({ prompt, tools }) => {
        prompts.get(name)!.push(prompt);
        exposed.push((tools ?? []).map(tool => tool.name));
        const tool = calls++ === 0;
        return { stream: new ReadableStream({ start(stream) {
          stream.enqueue({ type: "stream-start", warnings: [] });
          if (tool) stream.enqueue({ type: "tool-call", toolCallId: "reused-call", toolName: "read_file", input: '{"path":"fixture.txt"}' });
          else { stream.enqueue({ type: "text-start", id: "answer" }); stream.enqueue({ type: "text-delta", id: "answer", delta: name }); stream.enqueue({ type: "text-end", id: "answer" }); }
          stream.enqueue({ type: "finish", finishReason: { unified: tool ? "tool-calls" : "stop", raw: tool ? "tool_calls" : "stop" },
            usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
          stream.close();
        } }) };
      } });
      child.session.subscribe(event => { if (event.type === "tool_approval_required") approvals.set(name, event.toolCallId); });
      await child.session.thread.create({ id: child.session.identity.getId(), title: name });
    }
    const turns = children.map((child, i) => child.run(`PRIVATE_TASK_${i}`));
    const deadline = Date.now() + 20000;
    while (approvals.size < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(approvals.size, 2);
    assert.ok(exposed.every(names => names.length === 1 && names[0] === "read_file"), "filter the full native/controller toolset");
    children[0]!.session.respondToToolApproval({ toolCallId: "reused-call", decision: "approve" });
    const first = await turns[0];
    assert.equal(first!.text, "first");
    assert.equal(children[1]!.session.approval.getToolCallId(), "reused-call");
    assert.ok(children[1]!.session.run.isRunning());
    children[1]!.session.respondToToolApproval({ toolCallId: "reused-call", decision: "decline", declineContext: { reason: "User declined tool execution." } });
    const second = await turns[1];
    assert.equal(second!.text, "second");
    assert.match(JSON.stringify(prompts.get("first")!.at(-1)), /READ_EVIDENCE/);
    assert.match(JSON.stringify(prompts.get("second")!.at(-1)), /User declined tool execution/);
    assert.doesNotMatch(JSON.stringify(prompts.get("first")), /PRIVATE_TASK_1/);
    assert.doesNotMatch(JSON.stringify(prompts.get("second")), /PRIVATE_TASK_0/);
    await children[0]!.dispose();
    assert.equal((await children[1]!.run("FOLLOW_UP_SECOND")).text, "second", "disposing one child must not close its sibling storage");
  } finally {
    await Promise.allSettled(children.map(child => child.dispose()));
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
