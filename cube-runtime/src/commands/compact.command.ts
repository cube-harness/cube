import type { CommandHandler } from "../command-manager.js";

export const COMPACT_SLASH_COMMAND = "/compact";

export const runCompactSlashCommand = async (input: {
  threadId: string;
  turnActive: boolean;
  finalizeMemory?: (threadId: string) => Promise<unknown>;
}): Promise<string> => {
  if (input.turnActive) {
    return "Cannot compact while an agent turn is active.";
  }

  if (input.finalizeMemory) {
    await input.finalizeMemory(input.threadId);
  }
  return "Memory compacted.";
};

export interface CompactCommandDependencies {
  getThreadId: () => string | null;
  isTurnActive: () => boolean;
  finalizeMemory?: (threadId: string) => Promise<unknown>;
  showMessage: (message: string) => void;
}

export const createCompactCommand = (
  dependencies: CompactCommandDependencies,
): CommandHandler => async () => {
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
