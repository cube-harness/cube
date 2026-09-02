import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Chalk } from "chalk";
import { MessageList } from "../src/components/message-list.js";
import { appTheme } from "../src/themes/app.theme.js";

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

test("finished assistant code blocks hide fences and the language label", () => {
  const fence = "`".repeat(3);
  const list = new MessageList();

  list.setMessages([{
    id: "assistant-code",
    role: "assistant",
    status: "done",
    content: `Example:\n\n${fence}typescript\nconst answer = 42;\n${fence}`,
  }]);

  const rendered = list.render(80).join("\n");
  assert.match(rendered, /const answer = 42;/);
  assert.doesNotMatch(rendered, /```|typescript/);
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
  assert.doesNotMatch(rendered, /Completed\.|```json/);
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

test("tool output shows two lines and Ctrl+T expands every transcript", () => {
  const list = new MessageList();
  const output = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n");

  list.upsertTool({
    id: "call-long",
    name: "execute_command",
    args: { command: "systeminfo" },
    status: "completed",
    result: output,
  });
  list.upsertTool({
    id: "call-second",
    name: "read_file",
    args: { path: "large.txt", extra: "must not render as JSON" },
    status: "completed",
    result: Array.from({ length: 12 }, (_, index) => `second ${index + 1}`).join("\n"),
  });

  const collapsed = list.render(100).join("\n");
  assert.match(collapsed, /line 2/);
  assert.doesNotMatch(collapsed, /line 3/);
  assert.match(collapsed, /… \+118 lines \(Ctrl\+T to view transcript\)/);
  assert.doesNotMatch(collapsed, /line 100/);
  assert.doesNotMatch(collapsed, /```json|Completed\.|Running\.\.\.|Reading input/);

  list.toggleTranscript();
  const expanded = list.render(100).join("\n");
  assert.match(expanded, /line 100/);
  assert.match(expanded, /second 12/);
});

test("native reasoning is a compact marker until the global transcript is expanded", () => {
  const nativeMessage = {
    id: "assistant-reasoning",
    role: "assistant",
    createdAt: "1970-01-01T00:00:10.000Z",
    content: {
      parts: [
        { type: "step-start", createdAt: 10_000 },
        {
          type: "reasoning",
          reasoning: "Inspecting the workspace before choosing a tool.",
          details: [{ type: "text", text: "Inspecting the workspace before choosing a tool." }],
          createdAt: 13_000,
        },
        {
          type: "tool-invocation",
          toolInvocation: {
            state: "result",
            toolCallId: "call-reasoning",
            toolName: "read_file",
            args: { path: "package.json" },
            result: "first\nsecond\nthird",
          },
        },
        { type: "text", text: "The package uses ESM." },
      ],
    },
  };
  const live = new MessageList();
  const restored = new MessageList();

  live.applySessionMessage(nativeMessage, true, 3_000);
  restored.setSessionMessages([nativeMessage] as never[]);

  const liveCollapsed = live.render(100).join("\n");
  assert.match(liveCollapsed, /Reasoning for 3s[\s\S]*read_file[\s\S]*The package uses ESM\./);
  assert.doesNotMatch(liveCollapsed, /Inspecting the workspace/);

  const restoredCollapsed = restored.render(100).join("\n");
  assert.match(restoredCollapsed, /Reasoning for 3s[\s\S]*read_file[\s\S]*The package uses ESM\./);
  assert.doesNotMatch(restoredCollapsed, /Inspecting the workspace/);

  for (const list of [live, restored]) {
    list.toggleTranscript();
    const expanded = list.render(100).join("\n");
    assert.match(
      expanded,
      /Reasoning for 3s[\s\S]*Inspecting the workspace before choosing a tool\./,
    );
  }

  assert.deepEqual(
    live.getMessages().map((message) => [message.role, message.id]),
    restored.getMessages().map((message) => [message.role, message.id]),
  );
});

test("reasoning marker appears only after the native reasoning phase finishes", () => {
  const list = new MessageList();
  const reasoningOnly = {
    id: "assistant-reasoning-only",
    role: "assistant",
    content: {
      parts: [{ type: "reasoning", reasoning: "private chain of thought" }],
    },
  };

  list.applySessionMessage(reasoningOnly, true, 17_000);
  assert.equal(list.render(100).join("\n"), "");

  list.applySessionMessage(reasoningOnly, false, 17_000);
  const rendered = list.render(100).join("\n");
  assert.match(rendered, /Reasoning for 17s/);
  assert.doesNotMatch(rendered, /private chain of thought/);

  list.toggleTranscript();
  const expanded = list.render(100).join("\n");
  assert.match(expanded, /Reasoning for 17s[\s\S]*private chain of thought/);
});

test("tool output collapses by rendered terminal rows even when JSON contains one huge escaped string", () => {
  const list = new MessageList();
  const css = Array.from(
    { length: 30 },
    (_, index) => `.selector-${index} { color: red; padding: ${index}px; }`,
  ).join("\n");

  list.upsertTool({
    id: "google-search",
    name: "server:GOOGLE_SEARCH_WEB",
    args: { query: "current docs" },
    status: "completed",
    result: { search_suggestions: `<style>\n${css}\n</style>` },
  });

  const collapsed = list.render(50).join("\n");
  assert.match(collapsed, /server:GOOGLE_SEARCH_WEB/);
  assert.match(collapsed, /… \+\d+ lines \(Ctrl\+T to view transcript\)/);
  assert.doesNotMatch(collapsed, /selector-29/);

  list.toggleTranscript();
  assert.match(list.render(50).join("\n"), /selector-29/);
});

test("live native messages match resumed tool and assistant order", () => {
  const live = new MessageList();
  const toolMessage = {
    id: "assistant-tool",
    role: "assistant",
    content: { parts: [{
      type: "tool-invocation",
      toolInvocation: {
        state: "result",
        toolCallId: "call-1",
        toolName: "execute_command",
        args: { command: "Get-Date" },
        result: "Thursday",
      },
    }] },
  };
  const finalMessage = {
    id: "assistant-final",
    role: "assistant",
    content: { parts: [{ type: "text", text: "Hôm nay là thứ Năm." }] },
  };
  live.applySessionMessage(toolMessage, true);
  live.applySessionMessage(finalMessage, true);

  const restored = new MessageList();
  restored.setSessionMessages([toolMessage, finalMessage] as never[]);
  const identity = (list: MessageList) => list.getMessages().map((message) => [message.role, message.id]);
  assert.deepEqual(identity(live), [
    ["tool", "call-1"],
    ["assistant", "assistant-final:text-1"],
  ]);
  assert.deepEqual(identity(restored), identity(live));
});

test("native invocation result replaces one existing tool entry", () => {
  const list = new MessageList();
  const message = {
    id: "assistant-tool",
    role: "assistant",
    content: { parts: [{
      type: "tool-invocation",
      toolInvocation: {
        state: "call",
        toolCallId: "call-1",
        toolName: "execute_command",
        args: { command: "Get-Date" },
      },
    }] },
  };
  list.applySessionMessage(message, true);
  list.applySessionMessage({
    ...message,
    content: { parts: [{
      type: "tool-invocation",
      toolInvocation: {
        ...message.content.parts[0].toolInvocation,
        state: "result",
        result: "Thursday",
      },
    }] },
  }, true);

  assert.equal(list.getMessages().length, 1);
  assert.match(list.render(100).join("\n"), /Thursday/);
});

test("does not persist empty streaming tool inputs after the assistant response", () => {
  const list = new MessageList();
  const currentMessage = {
    id: "assistant-final",
    role: "assistant",
    content: {
      parts: [
        { type: "text", text: "Hôm nay là thứ Năm, ngày 27 tháng 8 năm 2026." },
        {
          type: "tool-invocation",
          toolInvocation: {
            state: "input-streaming",
            toolCallId: "call-empty-1",
            toolName: "mastra_workspace_execute_command",
            args: {},
          },
        },
        {
          type: "tool-invocation",
          toolInvocation: {
            state: "input-streaming",
            toolCallId: "call-empty-2",
            toolName: "mastra_workspace_execute_command",
            args: {},
          },
        },
      ],
    },
  };

  list.applySessionMessage(currentMessage, true);

  assert.deepEqual(
    list.getMessages().map((message) => [message.role, message.id]),
    [["assistant", "assistant-final:text-1"]],
  );
  assert.doesNotMatch(list.render(100).join("\n"), /Reading input\.\.\./);

  list.applySessionMessage(currentMessage, false);

  assert.deepEqual(
    list.getMessages().map((message) => [message.role, message.id]),
    [["assistant", "assistant-final:text-1"]],
  );
});

test("maps user, tool, and system prefixes to primary, secondary, and tertiary", () => {
  const originalPrimary = appTheme.ui.primary;
  const originalSecondary = appTheme.ui.secondary;
  const originalTertiary = appTheme.ui.tertiary;

  try {
    const primary = ((text: string) => `<primary>${text}</primary>`) as typeof originalPrimary;
    primary.bgHex = () => primary;
    appTheme.ui.primary = primary;
    appTheme.ui.secondary = ((text: string) =>
      `<secondary>${text}</secondary>`) as typeof originalSecondary;
    appTheme.ui.tertiary = ((text: string) =>
      `<tertiary>${text}</tertiary>`) as typeof originalTertiary;

    const list = new MessageList();
    list.setMessages([
      { id: "user-1", role: "user", content: "Question" },
      {
        id: "tool-1",
        role: "tool",
        content: "",
        tool: {
          id: "tool-1",
          name: "execute_command",
          args: { command: "Get-Date" },
          status: "completed",
          result: "Thursday",
        },
      },
      { id: "system-1", role: "system", content: "System notice" },
    ]);

    const rendered = list.render(200).join("\n");
    assert.match(rendered, /<primary>\s*❯\s*<\/primary>/);
    assert.match(rendered, /<secondary>\s*❖\s*<\/secondary>/);
    assert.match(rendered, /<tertiary>\s*❖\s*<\/tertiary>/);
  } finally {
    appTheme.ui.primary = originalPrimary;
    appTheme.ui.secondary = originalSecondary;
    appTheme.ui.tertiary = originalTertiary;
  }
});

test("fills every rendered user-message row with surface.background", () => {
  const originalUser = appTheme.role.user;
  const originalPrimary = appTheme.ui.primary;
  const originalText = appTheme.ui.text;
  const ansi = new Chalk({ level: 3 });

  try {
    appTheme.role.user = ansi.hex("#F2EDE5").bold;
    appTheme.ui.primary = ansi.hex("#38BDF8");
    appTheme.ui.text = ansi.hex("#F2EDE5");

    const list = new MessageList();
    list.setMessages([{
      id: "user-background",
      role: "user",
      content: "A user message that wraps onto another terminal row",
    }]);

    const rows = list.render(20).filter((line) => line.length > 0);
    assert.ok(rows.length > 1);
    for (const row of rows) {
      assert.equal(visibleWidth(row), 20);
      assert.match(row, /\u001b\[48;2;32;32;32m/);
    }
  } finally {
    appTheme.role.user = originalUser;
    appTheme.ui.primary = originalPrimary;
    appTheme.ui.text = originalText;
  }
});

test("adds one surface-background padding row above and below a user message", () => {
  const originalUser = appTheme.role.user;
  const originalPrimary = appTheme.ui.primary;
  const originalText = appTheme.ui.text;
  const ansi = new Chalk({ level: 3 });

  try {
    appTheme.role.user = ansi.hex("#F2EDE5").bold;
    appTheme.ui.primary = ansi.hex("#38BDF8");
    appTheme.ui.text = ansi.hex("#F2EDE5");

    const list = new MessageList();
    list.setMessages([{
      id: "user-vertical-padding",
      role: "user",
      content: "Hello",
    }]);

    const rows = list.render(20);
    assert.equal(rows.length, 4);
    assert.equal(stripTerminalSequences(rows[0]!).trim(), "");
    assert.match(stripTerminalSequences(rows[1]!), /❯ Hello/);
    assert.equal(stripTerminalSequences(rows[2]!).trim(), "");
    assert.equal(rows[3], "");
    for (const row of rows.slice(0, 3)) {
      assert.equal(visibleWidth(row), 20);
      assert.match(row, /\u001b\[48;2;32;32;32m/);
    }
  } finally {
    appTheme.role.user = originalUser;
    appTheme.ui.primary = originalPrimary;
    appTheme.ui.text = originalText;
  }
});
