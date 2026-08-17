import type { FinalizeMemoryResult } from "@cube/agent";
import type { SlashCommandHandler } from "./registry.js";

export const COMPACT_SLASH_COMMAND = "/compact";

export const runCompactSlashCommand = async (input: {
  threadId: string;
  turnActive: boolean;
  finalizeMemory: (threadId: string) => Promise<FinalizeMemoryResult>;
}): Promise<string> => {
  if (input.turnActive) {
    return "Cannot compact while an agent turn is active.";
  }

  const result = await input.finalizeMemory(input.threadId);
  if (result.status === "disabled") {
    return "Observational Memory is disabled.";
  }
  if (result.status === "no-op") {
    return "Nothing to compact.";
  }

  const actions = [
    result.activated && "activated buffered observations",
    result.observed && "observed pending messages",
    result.reflected && "reflected observations",
  ].filter(Boolean).join(", ");
  return `Memory finalized: ${actions}.`;
};

export interface CompactCommandDependencies {
  getThreadId: () => string | null;
  isTurnActive: () => boolean;
  finalizeMemory: (threadId: string) => Promise<FinalizeMemoryResult>;
  showMessage: (message: string) => void;
}

export const createCompactCommandHandler = (
  dependencies: CompactCommandDependencies,
): SlashCommandHandler => async () => {
  const threadId = dependencies.getThreadId();
  if (!threadId) {
    dependencies.showMessage("No active thread to compact.");
    return;
  }

  dependencies.showMessage(await runCompactSlashCommand({
    threadId,
    turnActive: dependencies.isTurnActive(),
    finalizeMemory: dependencies.finalizeMemory,
  }));
};
