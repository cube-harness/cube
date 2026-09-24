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

test("native approval stores actual diffs but sends the model a short result, including on resume", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cube-native-tools-"));
  const files = createFileTools(root);
  const requests: any[] = [];
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async ({ prompt, tools }) => {
    requests.push({ prompt, tools });
    const first = calls++ === 0;
    const chunks = first ? [
      { type: "tool-call", toolCallId: "edit-call", toolName: "edit_file", input: JSON.stringify({ path: "a.txt", old_string: "before", new_string: "after" }) },
    ] : [
      { type: "text-start", id: "answer" }, { type: "text-delta", id: "answer", delta: "done" }, { type: "text-end", id: "answer" },
    ];
    return { stream: new ReadableStream({ start(controller) {
      for (const chunk of [{ type: "stream-start", warnings: [] }, ...chunks, {
        type: "finish", finishReason: { unified: first ? "tool-calls" : "stop", raw: first ? "tool_calls" : "stop" },
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
    await configureCubePermissions(session, { require_approval_for: ["edit_file"] });
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
    } finally { resumed.thread.detachFromCurrent(); await resumed.thread.clearAndReleaseLock(); }
  } finally {
    session.thread.detachFromCurrent();
    await session.thread.clearAndReleaseLock();
    await mastra.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
