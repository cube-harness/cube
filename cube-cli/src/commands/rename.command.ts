import type { Session } from "@cube/agent";
import type { TuiApp } from "@cube/tui";
import type { CommandHandler } from "../command-manager.js";

export interface RenameCommandDependencies {
  session: Session;
  getApp: () => TuiApp | undefined;
  showMessage: (message: string) => void;
  isTurnActive?: () => boolean;
}

export const createRenameCommandHandler = (
  deps: RenameCommandDependencies,
): CommandHandler => async (rawArgument: string) => {
  if (deps.isTurnActive?.()) {
    deps.showMessage("Cannot rename thread while an agent turn is active.");
    return;
  }

  const currentThreadId = deps.session.thread.getId();
  if (!currentThreadId) {
    deps.showMessage("No active thread to rename. Send a message or create a thread first.");
    return;
  }

  const title = rawArgument.trim();
  if (!title) {
    deps.showMessage("Usage: /rename <new-title>");
    return;
  }

  try {
    await deps.session.thread.rename({ title });
    deps.showMessage(`• Renamed thread to: "${title}"`);
  } catch (error: unknown) {
    deps.showMessage(
      `Failed to rename thread: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
