import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "@cube/agent";
import { ActionDispatcher } from "../src/dispatcher.js";
import {
  createCopyCommand,
  extractLastAssistantResponse,
} from "../src/commands/copy.command.js";

test("extractLastAssistantResponse correctly extracts text and skips tool calls", () => {
  // 1. Simple text messages
  const messages1 = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "This is the answer" },
  ];
  assert.equal(extractLastAssistantResponse(messages1), "This is the answer");

  // 2. Message with tool invocations only vs text parts
  const messages2 = [
    { role: "user", content: "Run a test" },
    {
      role: "assistant",
      content: {
        parts: [
          {
            type: "tool-invocation",
            toolInvocation: { toolName: "run_test", args: {} },
          },
        ],
      },
    },
    { role: "tool", content: "Test passed" },
    {
      role: "assistant",
      content: {
        parts: [
          { type: "text", text: "## Test Results\nAll 10 tests passed." },
        ],
      },
    },
  ];
  assert.equal(
    extractLastAssistantResponse(messages2),
    "## Test Results\nAll 10 tests passed.",
  );

  // 3. Last message is tool-only -> should scan backwards to find previous text response
  const messages3 = [
    { role: "user", content: "Question" },
    { role: "assistant", content: "Previous answer" },
    {
      role: "assistant",
      content: {
        parts: [
          {
            type: "tool-invocation",
            toolInvocation: { toolName: "read_file", args: {} },
          },
        ],
      },
    },
  ];
  assert.equal(extractLastAssistantResponse(messages3), "Previous answer");

  // 4. No assistant messages
  const messages4 = [{ role: "user", content: "Only user prompt" }];
  assert.equal(extractLastAssistantResponse(messages4), null);
});

test("CopyCommand copies the last assistant response to clipboard", async () => {
  let copiedText = "";
  const emittedEvents: any[] = [];

  const session = {
    thread: {
      getId: () => "thread-123",
      listMessages: async () => [
        { role: "user", content: "write python code" },
        {
          role: "assistant",
          content: "```python\nprint('hello')\n```",
        },
      ],
    },
  } as unknown as Session;

  const dispatcher = new ActionDispatcher();
  dispatcher.subscribe((evt) => {
    emittedEvents.push(evt);
  });

  const handler = createCopyCommand({
    session,
    dispatcher,
    copyFn: async (text) => {
      copiedText = text;
      return true;
    },
  });

  await handler("/copy");

  assert.equal(copiedText, "```python\nprint('hello')\n```");
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].type, "system:message");
  assert.match(emittedEvents[0].content, /Copied last response to clipboard/);
});

test("CopyCommand notifies when no active thread exists", async () => {
  const emittedEvents: any[] = [];
  const session = {
    thread: {
      getId: () => null,
      listMessages: async () => [],
    },
  } as unknown as Session;

  const dispatcher = new ActionDispatcher();
  dispatcher.subscribe((evt) => {
    emittedEvents.push(evt);
  });

  const handler = createCopyCommand({
    session,
    dispatcher,
  });

  await handler("/copy");

  assert.equal(emittedEvents.length, 1);
  assert.match(emittedEvents[0].content, /No active thread/);
});

test("CopyCommand notifies when no assistant response is found", async () => {
  const emittedEvents: any[] = [];
  const session = {
    thread: {
      getId: () => "thread-empty",
      listMessages: async () => [{ role: "user", content: "hello" }],
    },
  } as unknown as Session;

  const dispatcher = new ActionDispatcher();
  dispatcher.subscribe((evt) => {
    emittedEvents.push(evt);
  });

  const handler = createCopyCommand({
    session,
    dispatcher,
  });

  await handler("/copy");

  assert.equal(emittedEvents.length, 1);
  assert.match(emittedEvents[0].content, /No assistant response found/);
});
