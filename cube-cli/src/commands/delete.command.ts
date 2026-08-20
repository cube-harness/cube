import type { Session } from "@cube/agent";
import type { TuiApp } from "@cube/tui";
import type { CommandHandler } from "../command-manager.js";

export interface DeleteCommandDependencies {
  session: Session;
  getApp: () => TuiApp | undefined;
  showMessage: (message: string) => void;
  isTurnActive?: () => boolean;
}

export const createDeleteCommandHandler = (
  deps: DeleteCommandDependencies,
): CommandHandler => async (rawArgument: string) => {
  if (deps.isTurnActive?.()) {
    deps.showMessage("Cannot delete thread while an agent turn is active.");
    return;
  }

  const app = deps.getApp();
  if (!app) {
    deps.showMessage("Cube TUI is not ready.");
    return;
  }

  const argument = rawArgument.trim();
  let targetThreadId = argument;

  if (!targetThreadId) {
    const threads = await deps.session.thread.list();
    if (!threads || threads.length === 0) {
      deps.showMessage("No threads found in this workspace.");
      return;
    }

    const activeId = deps.session.thread.getId();
    const selected = await app.openThreadPicker({
      threads: threads.map((t: { id: string; title?: string; updatedAt?: Date | string }) => ({
        id: t.id,
        title: t.title || "Untitled Thread",
        updatedAt: t.updatedAt
          ? new Date(t.updatedAt).toISOString()
          : new Date().toISOString(),
        isActive: t.id === activeId,
      })),
    });

    if (!selected) return;
    targetThreadId = selected;
  }

  try {
    const currentActiveId = deps.session.thread.getId();
    await deps.session.thread.delete({ threadId: targetThreadId });

    if (targetThreadId === currentActiveId) {
      await deps.session.thread.detachFromCurrent?.();
      app.clearMessages();
      app.setInfo({ threadId: "new thread" });
      deps.showMessage("• Deleted active thread. Started a fresh thread session.");
    } else {
      deps.showMessage(`• Deleted thread: ${targetThreadId}`);
    }
  } catch (error: unknown) {
    deps.showMessage(
      `Failed to delete thread: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
