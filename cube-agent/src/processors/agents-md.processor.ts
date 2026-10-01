import { convertMessages, isUserAuthoredMessage } from "@mastra/core/agent";
import type { InputProcessor } from "@mastra/core/processors";
import { extractGlobBase, isGlobPattern } from "@mastra/core/workspace";
import { parsePatch } from "../tools/apply-patch.js";

/** Deliver an already-loaded snapshot without changing conversation history. */
export const createAgentsMdProcessor = (
  readContext: () => string,
  discover?: (paths: string[]) => Promise<void>,
  protect?: (message: object) => void,
): InputProcessor => ({
  id: "cube-agents-md",

  processInput({ messageList, state }) {
    state.userId = messageList.get.input.db().filter(isUserAuthoredMessage).at(-1)?.id;
    return messageList;
  },

  async processInputStep({ messageList, state }) {
    if (discover) {
      const seen = (state.contextToolCalls ??= new Set<string>()) as Set<string>;
      const paths: string[] = [];
      for (const message of messageList.get.response.db()) {
        for (const part of message.content.parts ?? []) {
          if (part.type !== "tool-invocation") continue;
          const call = part.toolInvocation;
          if (call.state !== "result" || seen.has(call.toolCallId)) continue;
          seen.add(call.toolCallId);
          const input = call.args as Record<string, unknown> | undefined;
          if (!input) continue;
          if (
            ["read_file", "list_files", "grep", "edit_file", "write_file"].includes(call.toolName)
          ) {
            const value = typeof input.path === "string" ? input.path : ".";
            paths.push(isGlobPattern(value) ? extractGlobBase(value) : value);
          } else if (call.toolName === "apply_patch" && typeof input.patch === "string") {
            try {
              for (const hunk of parsePatch(input.patch).hunks) {
                paths.push(hunk.path);
                if (hunk.type === "update" && hunk.move_path) paths.push(hunk.move_path);
              }
            } catch {
              /* A rejected malformed patch has no reliable paths to discover. */
            }
          }
        }
      }
      if (paths.length) await discover(paths);
    }
    // Native Session also represents real user submissions/steers as signals.
    const latest = messageList.get.input.db().filter(isUserAuthoredMessage).at(-1);
    if (latest) state.userId = latest.id;
    const messages = messageList.get.all.db();
    const index = messages.findIndex((message) => message.id === state.userId);
    state.usersFromAnchor =
      index < 0
        ? 0
        : convertMessages(messages.slice(index))
            .to("AIV5.Model")
            .filter(
              (message) =>
                message.role === "user" &&
                (typeof message.content === "string"
                  ? message.content.length > 0
                  : message.content.some((part) => part.type !== "text" || part.text.length > 0)),
            ).length;
  },

  processLLMRequest({ prompt, state }) {
    const context = readContext();
    if (!context) return;

    // Conversion strips DB ids. Native user-message order survives conversion;
    // count from the end so system additions and Gemini's leading filler cannot
    // move the anchor. Never guess by matching the user's text.
    let remaining = Number(state.usersFromAnchor ?? 0);
    let index = -1;
    for (let cursor = prompt.length - 1; remaining > 0 && cursor >= 0; cursor--) {
      if (prompt[cursor]?.role === "user" && --remaining === 0) index = cursor;
    }
    if (index < 0) {
      index = prompt.findIndex((message) => message.role !== "system");
      if (index < 0) index = prompt.length;
    }
    const injected = { role: "user" as const, content: [{ type: "text" as const, text: context }] };
    protect?.(injected);
    return {
      prompt: [...prompt.slice(0, index), injected, ...prompt.slice(index)],
    };
  },
});
