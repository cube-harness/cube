import assert from "node:assert/strict";
import test from "node:test";
import type { CubeSession } from "@cube/agent";
import type { createApp, ToolApprovalOptions } from "@cube/tui";
import { subscribeToSession } from "../src/session-events.js";

type SessionEvent = Parameters<Parameters<CubeSession["subscribe"]>[0]>[0];

const createApprovalHarness = (decision: boolean | Error) => {
  let listener: ((event: SessionEvent) => void | Promise<void>) | undefined;
  const pickerRequests: ToolApprovalOptions[] = [];
  const systemMessages: string[] = [];
  const approvalResponses: Array<{
    decision: "approve" | "decline" | "always_allow_category";
    toolCallId?: string;
    declineContext?: { reason?: string; message?: string };
  }> = [];

  const session = {
    subscribe: (next: typeof listener) => {
      listener = next;
      return () => undefined;
    },
    approval: {
      isArmed: () => true,
      getToolCallId: () => "tool-call-1",
    },
    respondToToolApproval: (response: (typeof approvalResponses)[number]) => {
      approvalResponses.push(response);
    },
  } as unknown as CubeSession;
  const app = {
    requestToolApproval: async (request: ToolApprovalOptions) => {
      pickerRequests.push(request);
      if (decision instanceof Error) throw decision;
      return decision;
    },
  } as unknown as ReturnType<typeof createApp>;

  subscribeToSession({
    session,
    app,
    showSystemMessage: (message) => { systemMessages.push(message); },
  });

  return {
    emit: async (event: SessionEvent) => {
      assert.ok(listener, "session listener was registered");
      await listener(event);
    },
    pickerRequests,
    approvalResponses,
    systemMessages,
  };
};

test("tool approval event opens the picker and approves the same tool call", async () => {
  const harness = createApprovalHarness(true);

  await harness.emit({
    type: "tool_approval_required",
    toolCallId: "tool-call-1",
    toolName: "mastra_workspace_execute_command",
    args: { command: "node -e \"console.log('ok')\"" },
  });

  assert.deepEqual(harness.pickerRequests, [{
    toolName: "mastra_workspace_execute_command",
    args: { command: "node -e \"console.log('ok')\"" },
  }]);
  assert.deepEqual(harness.approvalResponses, [{
    decision: "approve",
    toolCallId: "tool-call-1",
  }]);
});

test("approval UI failure reports the error and releases the waiting tool", async () => {
  const harness = createApprovalHarness(new Error("terminal unavailable"));

  await harness.emit({
    type: "tool_approval_required",
    toolCallId: "tool-call-1",
    toolName: "filesystem_write_file",
    args: { path: "README.md" },
  });

  assert.match(harness.systemMessages[0] ?? "", /terminal unavailable/);
  assert.deepEqual(harness.approvalResponses, [{
    decision: "decline",
    toolCallId: "tool-call-1",
    declineContext: { reason: "Approval UI failed." },
  }]);
});
