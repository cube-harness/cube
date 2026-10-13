import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { createCubeTools } from "../src/tools/cube-tools.js";

test("subagent management validates action arguments and keeps command routing separate", async () => {
  const cube = createCubeTools(tmpdir());
  try {
    const tool = cube.forModel("google/test").manage_subagent;
    assert.ok(tool, "Parent models must have a separate subagent management tool");
    const context = { agent: { threadId: "owner-thread" } } as never;
    await assert.rejects(tool.execute!({ action: "list" } as never, {} as never), /calling thread/);
    await assert.rejects(tool.execute!({ action: "list" } as never, context), /unavailable/);
    const calls: unknown[] = [];
    cube.setTaskHandler(async () => { assert.fail("Child management reached the command handler"); });
    cube.setSubagentHandler(async (input, threadId) => {
      calls.push({ input, threadId });
      return { status: "completed", text: "Final child response" };
    });
    const id = "00000000-0000-4000-8000-000000000000";
    assert.deepEqual(await tool.execute!({ action: "get", id, view: "result" } as never, context),
      { status: "completed", text: "Final child response" });
    await tool.execute!({ action: "list" } as never, context);
    await tool.execute!({ action: "kill", id } as never, context);
    assert.deepEqual(calls, [
      { input: { action: "get", id, view: "result" }, threadId: "owner-thread" },
      { input: { action: "list" }, threadId: "owner-thread" },
      { input: { action: "kill", id }, threadId: "owner-thread" },
    ]);
    for (const [input, field] of [
      [{ action: "get" }, "id"],
      [{ action: "get", id: "1234" }, "id"],
      [{ action: "get", id, view: "live" }, "view"],
      [{ action: "kill", id, view: "result" }, "view"],
      [{ action: "list", threadId: "foreign" }, "threadId"],
      [{ action: "status", id }, "action"],
    ] as const) {
      const invalid = await tool.execute!(input as never, context) as any;
      assert.equal(invalid.error, true);
      assert.match(invalid.message, new RegExp(field));
    }
    assert.equal(calls.length, 3, "Invalid arguments must not reach a service");
    cube.setSubagentHandler(async () => { throw new Error("Unknown or unavailable subagent"); });
    await assert.rejects(tool.execute!({ action: "get", id } as never, context), /Unknown or unavailable subagent/);
  } finally { await cube.dispose(); }
});
