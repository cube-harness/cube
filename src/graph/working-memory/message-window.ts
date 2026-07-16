import {
  AIMessage,
  BaseMessage,
  ToolMessage,
  trimMessages,
  type TrimMessagesFields,
} from "@langchain/core/messages";

export type MessageTokenCounter = TrimMessagesFields["tokenCounter"];

export interface SelectModelInputMessagesArgs {
  messages: BaseMessage[];
  summarizedThroughMessageId?: string;
}

export interface PrepareSummaryWindowArgs extends SelectModelInputMessagesArgs {
  triggerTokens: number;
  recentTokensToKeep: number;
  tokenCounter: MessageTokenCounter;
}

export interface ShouldRunWorkingMemoryArgs extends SelectModelInputMessagesArgs {
  triggerTokens: number;
  tokenCounter: MessageTokenCounter;
}

export interface SummaryWindow {
  shouldSummarize: boolean;
  messagesToSummarize: BaseMessage[];
  summarizedThroughMessageId?: string;
}

export function selectModelInputMessages({
  messages,
  summarizedThroughMessageId,
}: SelectModelInputMessagesArgs): BaseMessage[] {
  return getMessagesAfterMarker(messages, summarizedThroughMessageId);
}

export async function shouldRunWorkingMemory({
  messages,
  summarizedThroughMessageId,
  triggerTokens,
  tokenCounter,
}: ShouldRunWorkingMemoryArgs): Promise<boolean> {
  const unsummarizedMessages = getMessagesAfterMarker(
    messages,
    summarizedThroughMessageId
  );

  return (await countMessageTokens(unsummarizedMessages, tokenCounter)) > triggerTokens;
}

export async function prepareSummaryWindow({
  messages,
  summarizedThroughMessageId,
  triggerTokens,
  recentTokensToKeep,
  tokenCounter,
}: PrepareSummaryWindowArgs): Promise<SummaryWindow> {
  const unsummarizedMessages = getMessagesAfterMarker(
    messages,
    summarizedThroughMessageId
  );

  if ((await countMessageTokens(unsummarizedMessages, tokenCounter)) <= triggerTokens) {
    return { shouldSummarize: false, messagesToSummarize: [] };
  }

  const recentMessages = await trimMessages(unsummarizedMessages, {
    maxTokens: recentTokensToKeep,
    tokenCounter,
    strategy: "last",
    allowPartial: false,
  });
  const firstRetainedMessageIndex = findFirstRetainedMessageIndex(
    unsummarizedMessages,
    recentMessages
  );

  if (firstRetainedMessageIndex < 0) {
    return { shouldSummarize: false, messagesToSummarize: [] };
  }

  const keepStartIndex = moveKeepStartBeforeAiResponse(
    unsummarizedMessages,
    firstRetainedMessageIndex
  );
  const safeCutIndex = moveCutBeforeInvalidToolBoundary(
    unsummarizedMessages,
    keepStartIndex
  );
  const messagesToSummarize = unsummarizedMessages.slice(0, safeCutIndex);
  const lastMessage = messagesToSummarize.at(-1);

  if (!lastMessage?.id) {
    return { shouldSummarize: false, messagesToSummarize: [] };
  }

  return {
    shouldSummarize: true,
    messagesToSummarize,
    summarizedThroughMessageId: lastMessage.id,
  };
}

function getMessagesAfterMarker(
  messages: BaseMessage[],
  summarizedThroughMessageId?: string
): BaseMessage[] {
  if (!summarizedThroughMessageId) {
    return messages;
  }

  const markerIndex = messages.findIndex(
    (message) => message.id === summarizedThroughMessageId
  );
  if (markerIndex < 0) {
    return messages;
  }

  return messages.slice(markerIndex + 1);
}

function findFirstRetainedMessageIndex(
  messages: BaseMessage[],
  retainedMessages: BaseMessage[]
): number {
  const firstRetainedMessage = retainedMessages.at(0);
  if (!firstRetainedMessage?.id) {
    return -1;
  }

  return messages.findIndex((message) => message.id === firstRetainedMessage.id);
}

function moveKeepStartBeforeAiResponse(
  messages: BaseMessage[],
  keepStartIndex: number
): number {
  const firstRetainedMessage = messages[keepStartIndex];
  const previousMessage = messages[keepStartIndex - 1];

  if (
    AIMessage.isInstance(firstRetainedMessage) &&
    previousMessage?.getType() === "human"
  ) {
    return keepStartIndex - 1;
  }

  return keepStartIndex;
}

function moveCutBeforeInvalidToolBoundary(
  messages: BaseMessage[],
  cutIndex: number
): number {
  if (cutIndex <= 0 || cutIndex >= messages.length) {
    return cutIndex;
  }

  const beforeCut = messages[cutIndex - 1]!;
  const afterCut = messages[cutIndex]!;

  if (AIMessage.isInstance(beforeCut) && beforeCut.tool_calls?.length) {
    return cutIndex - 1;
  }

  if (ToolMessage.isInstance(afterCut)) {
    const toolCallId = afterCut.tool_call_id;
    const matchingAiIndex = findMatchingToolCallMessageIndex(
      messages,
      toolCallId
    );

    if (matchingAiIndex >= 0 && matchingAiIndex < cutIndex) {
      return matchingAiIndex;
    }
  }

  return cutIndex;
}

function findMatchingToolCallMessageIndex(
  messages: BaseMessage[],
  toolCallId: string
): number {
  return messages.findIndex(
    (message) =>
      AIMessage.isInstance(message) &&
      message.tool_calls?.some((toolCall) => toolCall.id === toolCallId)
  );
}

async function countMessageTokens(
  messages: BaseMessage[],
  tokenCounter: MessageTokenCounter
): Promise<number> {
  if (isModelTokenCounter(tokenCounter)) {
    const tokenCounts = await Promise.all(
      messages.map((message) => tokenCounter.getNumTokens(message.content))
    );

    return tokenCounts.reduce((total, tokenCount) => total + tokenCount, 0);
  }

  return tokenCounter(messages);
}

function isModelTokenCounter(
  tokenCounter: MessageTokenCounter
): tokenCounter is Extract<MessageTokenCounter, { getNumTokens: Function }> {
  return (
    typeof tokenCounter === "object" &&
    tokenCounter !== null &&
    "getNumTokens" in tokenCounter
  );
}
