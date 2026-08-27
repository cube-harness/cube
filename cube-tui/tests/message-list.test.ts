import assert from "node:assert/strict";
import test from "node:test";
import { MessageList } from "../src/components/message-list.js";

test("renders streaming assistant text literally and final Markdown once", () => {
  const list = new MessageList();

  list.upsertMessage({
    id: "message-1",
    role: "assistant",
    content: "**bold**",
    status: "streaming",
  });

  assert.match(list.render(80).join("\n"), /\*\*bold\*\*/);

  list.upsertMessage({
    id: "message-1",
    role: "assistant",
    content: "**bold**",
    status: "done",
  });

  const rendered = list.render(80).join("\n");
  assert.equal(list.getMessages().length, 1);
  assert.doesNotMatch(rendered, /\*\*bold\*\*/);
  assert.match(rendered, /bold/);
});

test("setMessages restores a structured tool invocation", () => {
  const list = new MessageList();

  list.setMessages([
    {
      id: "call-1",
      role: "tool",
      toolName: "mastra_workspace_execute_command",
      content: "",
      status: "done",
      tool: {
        id: "call-1",
        name: "mastra_workspace_execute_command",
        args: { command: "powershell -Command \"Get-Date\"" },
        status: "completed",
        result: "Friday, 21/08/2026 21:49:09\r\n",
      },
    } as any,
  ]);

  const rendered = list.render(100).join("\n");
  assert.match(rendered, /mastra_workspace_execute_command/);
  assert.match(rendered, /powershell -Command "Get-Date"/);
  assert.match(rendered, /Friday, 21\/08\/2026 21:49:09/);
  assert.match(rendered, /Completed\./);
});

test("native Session message parts preserve tool-before-assistant order across updates", () => {
  const list = new MessageList();
  const message = {
    id: "assistant-1",
    role: "assistant",
    content: {
      format: 2,
      parts: [
        {
          type: "tool-invocation",
          toolInvocation: {
            state: "result",
            toolCallId: "call-1",
            toolName: "execute_command",
            args: { command: "Get-Date" },
            result: "Friday",
          },
        },
        { type: "text", text: "Hôm nay là Thứ Sáu." },
      ],
    },
  };

  list.applySessionMessage(message as never, false);
  list.applySessionMessage(
    {
      ...message,
      content: {
        ...message.content,
        parts: [
          message.content.parts[0],
          { type: "text", text: "Hôm nay là Thứ Sáu, ngày 21." },
        ],
      },
    } as never,
    true,
  );

  assert.deepEqual(
    list.getMessages().map((entry) => [entry.role, entry.id]),
    [
      ["tool", "call-1"],
      ["assistant", "assistant-1:text-1"],
    ],
  );
  assert.match(list.render(100).join("\n"), /Friday[\s\S]*Hôm nay là Thứ Sáu, ngày 21\./);
});

test("long tool output is collapsed until the transcript binding toggles it", () => {
  const list = new MessageList();
  const output = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n");

  list.upsertTool({
    id: "call-long",
    name: "execute_command",
    args: { command: "systeminfo" },
    status: "completed",
    result: output,
  });

  const collapsed = list.render(100).join("\n");
  assert.match(collapsed, /lines \(ctrl\+t to view transcript\)/i);
  assert.doesNotMatch(collapsed, /line 100/);

  list.toggleToolOutput();
  assert.match(list.render(100).join("\n"), /line 100/);
});

test("prioritizes final invocation status over stale activeTools running status", () => {
  const list = new MessageList();
  const activeTools = new Map([
    ["call-1", { id: "call-1", name: "execute_command", status: "running" as const, args: {} }],
  ]);

  list.applySessionDisplayState({
    currentMessage: {
      id: "assistant-1",
      role: "assistant",
      content: {
        parts: [
          {
            type: "tool-invocation",
            toolInvocation: {
              state: "result",
              toolCallId: "call-1",
              toolName: "execute_command",
              args: { command: "Get-Date" },
              result: "Thursday, 27/08/2026",
            },
          },
        ],
      },
    },
    isRunning: true,
    activeTools,
  });

  const rendered = list.render(100).join("\n");
  assert.match(rendered, /Completed\./);
  assert.doesNotMatch(rendered, /Running\.\.\./);
});

test("does not duplicate completed tool calls across multi-step turns", () => {
  const list = new MessageList();

  // Step 1: Tool 1 completes, Tool 2 running
  const activeTools = new Map([
    ["call-1", { id: "call-1", name: "execute_command", status: "running" as const, args: {} }],
    ["call-2", { id: "call-2", name: "execute_command", status: "running" as const, args: {} }],
  ]);

  list.applySessionDisplayState({
    currentMessage: {
      id: "assistant-msg-1",
      role: "assistant",
      content: {
        parts: [
          {
            type: "tool-invocation",
            toolInvocation: {
              state: "result",
              toolCallId: "call-1",
              toolName: "execute_command",
              args: { command: "cmd 1" },
              result: "Result 1",
            },
          },
          {
            type: "tool-invocation",
            toolInvocation: {
              state: "result",
              toolCallId: "call-2",
              toolName: "execute_command",
              args: { command: "cmd 2" },
              result: "Result 2",
            },
          },
          {
            type: "text",
            text: "Hôm nay là Thứ Năm.",
          },
        ],
      },
    },
    isRunning: false,
    activeTools,
  });

  const messages = list.getMessages();
  assert.equal(messages.length, 3);
  assert.equal(messages[0].tool?.id, "call-1");
  assert.equal(messages[1].tool?.id, "call-2");
  assert.equal(messages[2].role, "assistant");
  assert.equal(messages[2].content, "Hôm nay là Thứ Năm.");

  const rendered = list.render(100).join("\n");
  const countRunning = (rendered.match(/Running\.\.\./g) || []).length;
  assert.equal(countRunning, 0);
});
