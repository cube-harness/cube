import type { CubeSession } from "@cube/agent";
import type {
  AgentDisplayItem,
  AgentDisplaySnapshot,
  createApp,
  DisplayTool,
} from "@cube/tui";

export const messageText = (message: unknown): string => {
  if (!message || typeof message !== "object" || !("content" in message)) {
    return "";
  }

  const content = message.content;
  if (!content || typeof content !== "object") return "";
  if ("content" in content && typeof content.content === "string") {
    return content.content;
  }
  if (!("parts" in content) || !Array.isArray(content.parts)) return "";

  return content.parts.map((part) => {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") {
      return "";
    }
    return "text" in part && typeof part.text === "string" ? part.text : "";
  }).join("");
};

export const messageRole = (message: unknown): string => {
  if (!message || typeof message !== "object" || !("role" in message)) {
    return "";
  }
  return typeof message.role === "string" ? message.role : "";
};

export const toAgentDisplaySnapshot = (
  session: CubeSession,
): AgentDisplaySnapshot => {
  const snapshot = session.displayState.get();
  const activeToolsList: DisplayTool[] = Array.from(
    snapshot.activeTools,
    ([id, tool]) => ({
      id,
      name: tool.name,
      args: tool.args,
      status: snapshot.pendingApproval?.toolCallId === id
        ? "waiting_approval" as const
        : tool.status,
      partialResult: tool.partialResult,
      result: tool.result,
      shellOutput: tool.shellOutput,
    }),
  );

  const toolsMap = new Map<string, DisplayTool>(
    activeToolsList.map((tool) => [tool.id, tool]),
  );
  const seenToolIds = new Set<string>();
  const items: AgentDisplayItem[] = [];

  const rawMessage = snapshot.currentMessage;
  const isAssistant = rawMessage && messageRole(rawMessage) === "assistant";

  if (isAssistant && rawMessage && typeof rawMessage === "object" && "content" in rawMessage) {
    const messageId = typeof (rawMessage as { id?: unknown }).id === "string"
      ? (rawMessage as { id: string }).id
      : "assistant-message";
    const status = snapshot.isRunning ? "streaming" as const : "done" as const;
    const content = (rawMessage as { content?: unknown }).content;

    if (content && typeof content === "object" && "parts" in content && Array.isArray((content as { parts: unknown[] }).parts)) {
      const parts = (content as { parts: unknown[] }).parts;
      parts.forEach((part, index) => {
        if (!part || typeof part !== "object") return;
        const partRecord = part as Record<string, unknown>;

        if (partRecord.type === "text" && typeof partRecord.text === "string" && partRecord.text.length > 0) {
          items.push({
            type: "assistant",
            id: `${messageId}-part-${index}`,
            content: partRecord.text,
            status,
          });
        } else if (partRecord.type === "tool-invocation" || partRecord.type === "tool-call") {
          const invocation = (partRecord.toolInvocation ?? partRecord) as Record<string, unknown>;
          const toolCallId = typeof invocation.toolCallId === "string"
            ? invocation.toolCallId
            : typeof invocation.id === "string" ? invocation.id : undefined;

          const isDeclined = invocation.state === "output-denied"
            || (invocation.approval && typeof invocation.approval === "object" && (invocation.approval as Record<string, unknown>).approved === false);

          if (toolCallId && toolsMap.has(toolCallId)) {
            const tool = toolsMap.get(toolCallId)!;
            items.push({
              type: "tool",
              tool: isDeclined ? { ...tool, status: "declined" } : tool,
            });
            seenToolIds.add(toolCallId);
          } else if (toolCallId) {
            items.push({
              type: "tool",
              tool: {
                id: toolCallId,
                name: typeof invocation.toolName === "string" ? invocation.toolName : "tool",
                args: invocation.args ?? invocation.rawInput,
                status: isDeclined
                  ? "declined"
                  : invocation.state === "output-error"
                    ? "error"
                    : "completed",
                result: invocation.result,
              },
            });
            seenToolIds.add(toolCallId);
          }
        }
      });
    } else {
      const text = messageText(rawMessage);
      if (text) {
        items.push({
          type: "assistant",
          id: messageId,
          content: text,
          status,
        });
      }
    }
  }

  for (const tool of activeToolsList) {
    if (!seenToolIds.has(tool.id)) {
      items.push({
        type: "tool",
        tool,
      });
    }
  }

  return {
    isRunning: snapshot.isRunning,
    approvalPending: session.approval.isArmed(),
    currentMessage: isAssistant
      ? {
          id: (rawMessage as { id?: string }).id ?? "assistant-message",
          content: messageText(rawMessage),
          status: snapshot.isRunning ? "streaming" : "done",
        }
      : null,
    activeTools: activeToolsList,
    items,
  };
};

export interface SubscribeToSessionInput {
  session: CubeSession;
  app: ReturnType<typeof createApp>;
  showSystemMessage: (message: string) => void;
}

export const subscribeToSession = (input: SubscribeToSessionInput) =>
  input.session.subscribe(async (event) => {
    if (event.type === "tool_approval_required") {
      try {
        const approved = await input.app.requestToolApproval({
          toolName: event.toolName,
          args: event.args,
        });
        if (input.session.approval.getToolCallId() !== event.toolCallId) return;
        if (approved) {
          input.session.respondToToolApproval({
            decision: "approve",
            toolCallId: event.toolCallId,
          });
        } else {
          input.session.respondToToolApproval({
            decision: "decline",
            toolCallId: event.toolCallId,
            declineContext: { reason: "User declined tool execution." },
          });
          input.session.abort?.();
        }
      } catch (error) {
        input.showSystemMessage(
          `Tool approval failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (input.session.approval.getToolCallId() !== event.toolCallId) return;
        input.session.respondToToolApproval({
          decision: "decline",
          toolCallId: event.toolCallId,
          declineContext: { reason: "Approval UI failed." },
        });
        input.session.abort?.();
      }
    } else if (event.type === "display_state_changed") {
      input.app.renderAgentDisplay(toAgentDisplaySnapshot(input.session));
    } else if (event.type === "model_changed") {
      input.app.setModel(event.modelId);
    } else if (event.type === "thread_created") {
      input.app.setInfo({ threadId: event.thread.id });
    } else if (event.type === "thread_changed") {
      input.app.setInfo({ threadId: event.threadId });
    } else if (event.type === "info") {
      input.showSystemMessage(event.message);
    } else if (event.type === "error") {
      input.showSystemMessage(event.error.message);
    }
  });
