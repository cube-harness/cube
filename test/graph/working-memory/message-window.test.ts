import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  prepareSummaryWindow,
  selectModelInputMessages,
  shouldRunWorkingMemory,
} from "../../../src/graph/working-memory/message-window.js";

function human(id: string, content: string): HumanMessage {
  return new HumanMessage({ id, content });
}

function ai(id: string, content: string): AIMessage {
  return new AIMessage({ id, content });
}

function tokenCounter(messages: BaseMessage[]): number {
  return messages.reduce(
    (total, message) => total + message.text.trim().split(/\s+/u).filter(Boolean).length,
    0
  );
}

describe("message window policy", () => {
  test("selectModelInputMessages returns unsummarized messages after marker", () => {
    const messages = [
      human("h1", "old"),
      ai("a1", "old answer"),
      human("h2", "new"),
    ];

    const selected = selectModelInputMessages({
      messages,
      summarizedThroughMessageId: "a1",
    });

    expect(selected.map((message) => message.id)).toEqual(["h2"]);
  });

  test("prepareSummaryWindow does not summarize below high watermark", async () => {
    const messages = [human("h1", "short one"), ai("a1", "short two")];

    const window = await prepareSummaryWindow({
      messages,
      summarizedThroughMessageId: undefined,
      triggerTokens: 100,
      recentTokensToKeep: 50,
      tokenCounter,
    });

    expect(window.shouldSummarize).toBe(false);
    expect(window.messagesToSummarize).toEqual([]);
    expect(window.summarizedThroughMessageId).toBeUndefined();
  });

  test("shouldRunWorkingMemory returns false below high watermark", async () => {
    const messages = [human("h1", "hello"), ai("a1", "hello there")];

    const shouldRun = await shouldRunWorkingMemory({
      messages,
      summarizedThroughMessageId: undefined,
      triggerTokens: 10,
      tokenCounter,
    });

    expect(shouldRun).toBe(false);
  });

  test("shouldRunWorkingMemory returns true above high watermark", async () => {
    const messages = [
      human("h1", "alpha beta gamma delta"),
      ai("a1", "epsilon zeta eta theta"),
    ];

    const shouldRun = await shouldRunWorkingMemory({
      messages,
      summarizedThroughMessageId: undefined,
      triggerTokens: 4,
      tokenCounter,
    });

    expect(shouldRun).toBe(true);
  });

  test("prepareSummaryWindow compacts older messages and keeps recent messages", async () => {
    const messages = [
      human("h1", "alpha beta gamma delta"),
      ai("a1", "epsilon zeta eta theta"),
      human("h2", "iota kappa lambda mu"),
      ai("a2", "nu xi omicron pi"),
    ];

    const window = await prepareSummaryWindow({
      messages,
      summarizedThroughMessageId: undefined,
      triggerTokens: 12,
      recentTokensToKeep: 6,
      tokenCounter,
    });

    expect(window.shouldSummarize).toBe(true);
    expect(window.messagesToSummarize.map((message) => message.id)).toEqual([
      "h1",
      "a1",
    ]);
    expect(window.summarizedThroughMessageId).toBe("a1");
  });

  test("prepareSummaryWindow keeps tool call and tool result together", async () => {
    const toolCallingAi = new AIMessage({
      id: "a1",
      content: "",
      tool_calls: [{ id: "call_1", name: "get_current_time", args: {} }],
    });
    const toolResult = new ToolMessage({
      id: "t1",
      content: "10:00",
      tool_call_id: "call_1",
    });
    const messages = [
      human("h1", "time?"),
      toolCallingAi,
      toolResult,
      ai("a2", "It is 10:00."),
      human("h2", "thanks"),
    ];

    const window = await prepareSummaryWindow({
      messages,
      summarizedThroughMessageId: undefined,
      triggerTokens: 4,
      recentTokensToKeep: 3,
      tokenCounter,
    });

    expect(window.shouldSummarize).toBe(true);
    expect(window.messagesToSummarize.map((message) => message.id)).toEqual([
      "h1",
      "a1",
      "t1",
      "a2",
    ]);
    expect(window.summarizedThroughMessageId).toBe("a2");
  });

  test("retained Vietnamese message is not partially truncated", () => {
    const messages = [
      human("h1", "old old old old old old old old"),
      human("h2", "tôi là phạm hoài phúc"),
    ];

    const selected = selectModelInputMessages({
      messages,
      summarizedThroughMessageId: "h1",
    });

    expect(selected[0]?.content).toBe("tôi là phạm hoài phúc");
  });
});
