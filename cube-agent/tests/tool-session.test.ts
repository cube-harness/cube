import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { AgentController } from "@mastra/core/agent-controller";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { MockLanguageModelV3 } from "ai/test";
import { createFileTools } from "../src/tools/file.tools.js";
import { configureCubePermissions } from "../src/permission.js";
import { CubeRuntime } from "../../cube-runtime/src/runtime.js";
import { cubeAskUserTool } from "../src/tools/ask-user.tool.js";

test("live Ask, Allow and Deny control actual agent-owned tool execution", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cube-live-tool-policies-"));
  const files = createFileTools(root);
  let issueTool = false;
  let target = "";
  let gates = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    const call = issueTool;
    issueTool = false;
    return { stream: new ReadableStream({ start(stream) {
      stream.enqueue({ type: "stream-start", warnings: [] });
      if (call) stream.enqueue({ type: "tool-call", toolCallId: target, toolName: "write_file",
        input: JSON.stringify({ path: target, content: "allowed" }) });
      stream.enqueue({ type: "finish", finishReason: { unified: call ? "tool-calls" : "stop", raw: call ? "tool_calls" : "stop" },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } });
      stream.close();
    } }) };
  } });
  const agent = new Agent({ id: "policy-agent", name: "Policy agent", instructions: "Test", model, tools: files.tools });
  const controller = new AgentController({ id: "policy-controller", agent,
    memory: new Memory({ options: { generateTitle: false, lastMessages: 100 } }),
    modes: [{ id: "default", name: "Default", metadata: { default: true } }],
    toolCategoryResolver: () => "other",
  });
  const mastra = new Mastra({ storage: new LibSQLStore({ id: "policy-test", url: ":memory:" }), agentControllers: { controller }, logger: false });
  const session = await controller.createSession({ resourceId: root });
  session.subscribe((event) => {
    if (event.type === "tool_approval_required") {
      gates++;
      session.respondToToolApproval({ decision: "approve", toolCallId: event.toolCallId });
    }
  });
  try {
    await session.thread.create({ id: "policy-thread" });
    for (const policy of ["ask", "allow", "deny"] as const) {
      await configureCubePermissions(session, {
        require_approval_for: policy === "ask" ? ["write_file"] : [],
        deny_for: policy === "deny" ? ["write_file"] : [],
      });
      issueTool = true;
      target = `${policy}.txt`;
      await session.followUp({ content: `Create ${target}` });
      if (policy === "deny") await assert.rejects(readFile(join(root, target)), { code: "ENOENT" });
      else assert.equal(await readFile(join(root, target), "utf8"), "allowed");
    }
    assert.equal(gates, 1, "only Ask should open an approval gate");
  } finally {
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
    await mastra.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

for (const mode of ["single", "parallel", "queued"]) {
const parallel = mode === "parallel";
test(`declining ${mode} ask_user lets the model continue and the next prompt finish`, { timeout: 15_000 }, async () => {
  let calls = 0;
  const requests: any[] = [];
  const model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
    requests.push(prompt);
    const first = calls++ === 0;
    return { stream: new ReadableStream({ start(stream) {
      stream.enqueue({ type: "stream-start", warnings: [] });
      if (first) {
        stream.enqueue({ type: "tool-call", toolCallId: "question", toolName: "ask_user", input: JSON.stringify({ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }) });
        if (parallel) stream.enqueue({ type: "tool-call", toolCallId: "other-question", toolName: "ask_user", input: JSON.stringify({ question: "Anything else?" }) });
      }
      else {
        stream.enqueue({ type: "text-start", id: "answer" });
        stream.enqueue({ type: "text-delta", id: "answer", delta: "fresh answer" });
        stream.enqueue({ type: "text-end", id: "answer" });
      }
      stream.enqueue({ type: "finish", finishReason: { unified: first ? "tool-calls" : "stop", raw: first ? "tool_calls" : "stop" }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } });
      stream.close();
    } }) };
  } });
  const agent = new Agent({ id: "cancel-question", name: "Cancel question", instructions: "Cube", model });
  const controller = new AgentController({ id: "cancel-controller", agent,
    memory: new Memory({ options: { generateTitle: false, lastMessages: 100 } }),
    modes: [{ id: "default", name: "Default", metadata: { default: true } }],
    tools: { ask_user: cubeAskUserTool }, disableBuiltinTools: ["ask_user"],
  });
  const mastra = new Mastra({ storage: new LibSQLStore({ id: "cancel", url: ":memory:" }), agentControllers: { controller }, logger: false });
  const session = await controller.createSession({ resourceId: "cancel-test" });
  const runtime = new CubeRuntime({ session, memory: { isManual: () => false } } as never);
  const questions: string[] = [];
  const errors: unknown[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_suspended") questions.push(event.toolCallId);
    if (event.type === "error") errors.push(event.error);
  });
  try {
    session.grantTool("ask_user");
    await session.thread.create({ id: "cancel-history" });
    await session.followUp({ content: "Ask me a question" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(questions.includes("question"));
    assert.equal(session.suspensions.hasPending(), true);
    let resolveNext: () => void;
    const nextEnded = new Promise<void>((resolve) => { resolveNext = resolve; });
    const stopNext = session.subscribe((event) => {
      if (event.type === "agent_end" && calls === 3) resolveNext();
    });
    const cancellation = runtime.cancelSuspension("question");
    const queuedPrompt = mode === "queued"
      ? session.followUp({ content: "Skip the question and say hello" }) : undefined;
    await cancellation;
    assert.equal(session.suspensions.hasPending(), false);
    assert.equal(session.run.isRunning(), false);
    if (!queuedPrompt) assert.equal(calls, 2, "the model must continue after receiving the decline");
    const stored = await session.thread.listMessages({ threadId: "cancel-history" });
    const invocation = stored.flatMap((message: any) => message.content.parts ?? [])
      .find((part: any) => part.toolInvocation?.toolCallId === "question") as any;
    assert.equal(invocation.toolInvocation.result, "User declined to answer the question");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const finished = await Promise.race([
        (async () => {
          await (queuedPrompt ?? session.followUp({ content: "Skip the question and say hello" }));
          await nextEnded;
          return true;
        })(),
        new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 3_000); }),
      ]);
      assert.equal(finished, true, "prompt after cancellation remained stuck");
    } finally { clearTimeout(timeout); stopNext(); }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(session.run.isRunning(), false);
    assert.equal(session.followUps.count(), 0);
    assert.deepEqual(questions, parallel ? ["question", "other-question"] : ["question"]);
    assert.deepEqual(errors, []);
    assert.equal(calls, 3);
    const outputs = requests[1].filter((message: any) => message.role === "tool")
      .flatMap((message: any) => message.content.map((part: any) => part.output));
    assert.deepEqual(outputs, Array.from({ length: parallel ? 2 : 1 }, () => ({
      type: "text", value: "User declined to answer the question",
    })));
  } finally {
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
    await mastra.shutdown();
  }
});
}

test("failed file preparation returns errors without requesting approval", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cube-invalid-tools-"));
  const files = createFileTools(root);
  const requests: any[] = [];
  const attempts = [
    { toolName: "write_file", input: { path: "../unauthorized.txt", content: "no" } },
    { toolName: "edit_file", input: { path: "../unauthorized.txt", old_string: "old", new_string: "new" } },
    { toolName: "apply_patch", input: { patch: "*** Begin Patch\n*** Add File: ../unauthorized.txt\n+no\n*** End Patch" } },
    { toolName: "edit_file", input: { path: "a.txt", old_string: "missing", new_string: "new" } },
    { toolName: "write_file", input: { path: "a.txt", content: "no" } },
    { toolName: "write_file", input: { path: "large.txt", content: "x".repeat(70_000) } },
  ];
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
    requests.push(prompt);
    const first = calls++ === 0;
    return { stream: new ReadableStream({ start(stream) {
      stream.enqueue({ type: "stream-start", warnings: [] });
      if (first) {
        for (const [index, attempt] of attempts.entries()) {
          stream.enqueue({ type: "tool-call", toolCallId: `invalid-${index}`, toolName: attempt.toolName, input: JSON.stringify(attempt.input) });
        }
      } else {
        stream.enqueue({ type: "text-start", id: "answer" });
        stream.enqueue({ type: "text-delta", id: "answer", delta: "done" });
        stream.enqueue({ type: "text-end", id: "answer" });
      }
      stream.enqueue({ type: "finish", finishReason: { unified: first ? "tool-calls" : "stop", raw: first ? "tool_calls" : "stop" }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } });
      stream.close();
    } }) };
  } });
  const agent = new Agent({ id: "invalid-files", name: "Invalid files", instructions: "Cube", model, tools: files.tools });
  const controller = new AgentController({ id: "invalid-controller", agent,
    memory: new Memory({ options: { generateTitle: false, lastMessages: 100 } }),
    modes: [{ id: "default", name: "Default", metadata: { default: true } }],
  });
  const mastra = new Mastra({ storage: new LibSQLStore({ id: "invalid-files", url: ":memory:" }), agentControllers: { controller }, logger: false });
  const session = await controller.createSession({ resourceId: root });
  const approvals: string[] = [];
  session.subscribe((event) => {
    if (event.type !== "tool_approval_required") return;
    approvals.push(event.toolCallId);
    session.respondToToolApproval({ decision: "decline", toolCallId: event.toolCallId });
  });
  try {
    await writeFile(join(root, "a.txt"), "before\n");
    await configureCubePermissions(session, { require_approval_for: ["write_file"] });
    await session.thread.create({ id: "invalid-history" });
    await session.followUp({ content: "Try the invalid file changes" });
    assert.deepEqual(approvals, [], "preparation failures must not open approval");
    const outputs = requests[1].filter((message: any) => message.role === "tool")
      .flatMap((message: any) => message.content.map((part: any) => part.output));
    assert.equal(outputs.length, attempts.length);
    for (const output of outputs.slice(0, 3)) {
      assert.deepEqual(output, { type: "text", value: "Permission denied: access on ../unauthorized.txt" });
    }
    assert.match(outputs[3].value, /not found|match/i);
    assert.match(outputs[4].value, /File exists/);
    assert.match(outputs[5].value, /Approval diff exceeds/);
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "before\n");
    await assert.rejects(readFile(join(root, "large.txt")), { code: "ENOENT" });
    assert.equal(session.run.isRunning(), false);
    assert.equal(session.suspensions.hasPending(), false);
    await session.followUp({ content: "Continue" });
    assert.equal(calls, 3);
  } finally {
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
    await mastra.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("native approval stores actual diffs but sends the model a short result, including on resume", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cube-native-tools-"));
  const files = createFileTools(root);
  const requests: any[] = [];
  let calls = 0;
  let nextEdit: string | undefined;
  const model = new MockLanguageModelV3({ doStream: async ({ prompt, tools }) => {
    requests.push({ prompt, tools });
    const first = calls++ === 0;
    const editPath = first ? "a.txt" : nextEdit;
    nextEdit = undefined;
    const chunks = editPath ? [
      { type: "tool-call", toolCallId: first ? "edit-call" : `edit-${calls}`, toolName: "edit_file", input: JSON.stringify({ path: editPath, old_string: "before", new_string: "after" }) },
    ] : [
      { type: "text-start", id: "answer" }, { type: "text-delta", id: "answer", delta: "done" }, { type: "text-end", id: "answer" },
    ];
    return { stream: new ReadableStream({ start(controller) {
      for (const chunk of [{ type: "stream-start", warnings: [] }, ...chunks, {
        type: "finish", finishReason: { unified: editPath ? "tool-calls" : "stop", raw: editPath ? "tool_calls" : "stop" },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } },
      }]) controller.enqueue(chunk);
      controller.close();
    } }) };
  } });
  const agent = new Agent({ id: "tool-test", name: "Tool test", instructions: "Cube", model, tools: { edit_file: files.tools.edit_file } });
  const controller = new AgentController({ id: "tools-controller", agent,
    memory: new Memory({ options: { generateTitle: false, lastMessages: 100 } }),
    modes: [{ id: "default", name: "Default", metadata: { default: true } }],
  });
  const mastra = new Mastra({ storage: new LibSQLStore({ id: "tools", url: ":memory:" }), agentControllers: { controller }, logger: false });
  const session = await controller.createSession({ resourceId: root });
  let approval: any;
  let assertionError: unknown;
  session.subscribe((event) => {
    if (event.type !== "tool_approval_required") return;
    approval = event;
    void (async () => {
      try {
        assert.equal(await readFile(join(root, "a.txt"), "utf8"), "before\n");
        assert.equal(files.hasPreview(event.toolCallId), true);
        assert.equal((event.args as any).preview.status, "proposed");
        assert.match((event.args as any).preview.changes[0].diff, /-before\n\+after/);
      } catch (error) { assertionError = error; }
      session.respondToToolApproval({ decision: assertionError ? "decline" : "approve", toolCallId: event.toolCallId });
    })();
  });
  try {
    await writeFile(join(root, "a.txt"), "before\n");
    await configureCubePermissions(session, { require_approval_for: ["edit_file", "apply_patch"] });
    assert.equal(session.resolveToolApproval("apply_patch"), "ask");
    await session.thread.create({ id: "tool-history" });
    await session.followUp({ content: "Edit the file" });
    if (assertionError) throw assertionError;
    assert.ok(approval);
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "after\n");
    const stored = await session.thread.listMessages({ threadId: "tool-history" });
    const invocation = stored.flatMap((m: any) => m.content.parts ?? []).find((p: any) => p.toolInvocation?.toolCallId === "edit-call") as any;
    assert.equal(invocation.toolInvocation.result.kind, "file_changes");
    assert.equal(invocation.toolInvocation.result.status, "applied");
    assert.match(invocation.toolInvocation.result.changes[0].diff, /-before\n\+after/);
    const toolMessages = requests.at(-1).prompt.filter((m: any) => m.role === "tool");
    // Provider options contain Mastra persistence metadata, not model content.
    const modelOutputs = toolMessages.flatMap((message: any) => message.content.map((part: any) => part.output));
    assert.deepEqual(modelOutputs, [{ type: "text", value: "update: a.txt (+1/-1)" }]);
    assert.equal(invocation.toolInvocation.args.path, "a.txt");
    await writeFile(join(root, "a.txt"), "different now\n");
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
    const resumed = await controller.createSession({ resourceId: root });
    try {
      const restored = await resumed.thread.listMessages({ threadId: "tool-history" });
      assert.deepEqual(restored, stored);
      await resumed.thread.switch({ threadId: "tool-history" });
      await resumed.followUp({ content: "Continue without editing" });
      const resumedOutputs = requests.at(-1).prompt.filter((m: any) => m.role === "tool").flatMap((m: any) => m.content.map((p: any) => p.output));
      assert.deepEqual(resumedOutputs, [{ type: "text", value: "update: a.txt (+1/-1)" }]);
      assert.equal(await readFile(join(root, "a.txt"), "utf8"), "different now\n");
      const unexpectedApprovals: string[] = [];
      resumed.subscribe((event) => {
        if (event.type !== "tool_approval_required") return;
        unexpectedApprovals.push(event.toolCallId);
        resumed.respondToToolApproval({ decision: "decline", toolCallId: event.toolCallId });
      });
      for (const policy of ["deny", "allow"] as const) {
        if (policy === "allow") await configureCubePermissions(resumed, { require_approval_for: [] });
        else await resumed.permissions.setForTool({ toolName: "edit_file", policy });
        nextEdit = `${policy}.txt`;
        await writeFile(join(root, nextEdit), "before\n");
        await resumed.followUp({ content: `Try the ${policy} policy` });
        assert.equal(await readFile(join(root, `${policy}.txt`), "utf8"), policy === "allow" ? "after\n" : "before\n");
      }
      assert.deepEqual(unexpectedApprovals, []);
    } finally { resumed.thread.detachFromCurrent(); await resumed.thread.clearAndReleaseLock(); }
  } finally {
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
    await mastra.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
