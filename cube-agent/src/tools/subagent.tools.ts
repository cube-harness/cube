import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const idError = 'id must be the UUID returned by a subagent role tool such as worker or explore. Example: {"action":"get","id":"<UUID>","view":"result"}.';
const id = z.string({ error: idError }).uuid({ error: idError });
const manageSubagentActionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({
    action: z.literal("get"),
    id,
    view: z.enum(["status", "result", "transcript", "changes"], {
      error: 'view must be status, result, transcript or changes. Example: {"action":"get","id":"<UUID>","view":"result"}.',
    }).optional().describe("Defaults to status. result reads the final response; transcript reads saved conversation, not a live stream."),
    cursor: z.string().optional().describe("Use nextCursor from a previous response for the same id/view/limit."),
    limit: z.number().int().min(1).max(100).optional().describe("Saved transcript messages per page; default 20."),
  }).strict(),
  z.object({ action: z.literal("kill"), id }).strict(),
], { error: 'action must be list, get or kill. Use {"action":"list"}, {"action":"get","id":"<UUID>","view":"status"} or {"action":"kill","id":"<UUID>"}.' });
// OpenAI requires an object at the schema root; the pipe retains per-action validation.
const manageSubagentInput = z.object({
  action: z.enum(["list", "get", "kill"]),
  ...manageSubagentActionInput.options[1].omit({ action: true }).partial().shape,
}).strict().pipe(manageSubagentActionInput);
export type ManageSubagentInput = z.infer<typeof manageSubagentInput>;

export function createSubagentTools() {
  let handler: ((input: ManageSubagentInput, threadId: string) => Promise<unknown>) | undefined;
  const manage_subagent = createTool({
    id: "manage_subagent",
    description: 'Manage delegated subagents in this conversation only, not command processes. Completion/failure is delivered automatically via subagent_result; do not repeatedly poll to wait for completion. Inspect when the user requests progress or you need additional evidence. action:list lists jobs; action:get requires the returned job UUID and defaults to view:status (lifecycle metadata). view:result reads the final child response or failure; view:transcript reads a bounded snapshot of saved messages/tool calls, not a live stream; view:changes reads worktree changes. action:kill requires id only. Example: {"action":"get","id":"<UUID>","view":"result"}. Use nextCursor for more pages. Historical jobs are read-only.',
    inputSchema: manageSubagentInput,
    execute: async (input, context) => {
      const threadId = context.agent?.threadId;
      if (!threadId) throw new Error("Subagent management requires a calling thread.");
      if (!handler) throw new Error("Subagent management is unavailable in this runtime.");
      return handler(input, threadId);
    },
  });
  return {
    tools: { manage_subagent },
    setHandler: (next: NonNullable<typeof handler>) => { handler = next; },
  };
}
