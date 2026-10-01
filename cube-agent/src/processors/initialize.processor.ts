import { isUserAuthoredMessage } from "@mastra/core/agent";
import type { InputProcessor, ProcessInputArgs } from "@mastra/core/processors";
import { INITIALIZE_PROMPT } from "../prompts/initialize.prompt.js";

// Expand only new /init submissions; persisted instructions survive later turns.
export const createInitializeProcessor = (): InputProcessor => {
  const expand = ({ messageList }: ProcessInputArgs) => {
    for (const message of messageList.get.input.db().filter(isUserAuthoredMessage)) {
      const text = message.content.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text !== "/init") continue;
      const metadata = message.content.metadata ?? {};
      const cube = (metadata.cube ?? {}) as Record<string, unknown>;
      messageList.add(
        {
          ...message,
          content: {
            ...message.content,
            parts: [{ type: "text", text: INITIALIZE_PROMPT }],
            metadata: { ...metadata, cube: { ...cube, displayText: "" } },
          },
        },
        "input",
        { merge: false },
      );
    }
    return messageList;
  };
  return { id: "cube-initialize", processInput: expand, processInputStep: expand };
};
