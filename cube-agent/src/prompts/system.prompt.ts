import type { CubeResult } from "@cube/workspace";

export const SYSTEM_PROMPT_SETTING_KEY = "cube.system_prompt";

interface SystemPromptThread {
  getId: () => string | null;
  getSetting: (input: { key: string }) => Promise<unknown>;
  setSetting: (input: { key: string; value: unknown }) => Promise<void>;
  create: (input?: { id?: string }) => Promise<{ id: string }>;
  delete: (input: { threadId: string }) => Promise<void>;
}

interface SystemPromptSession {
  thread: SystemPromptThread;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const createSystemPrompt = (
  session: SystemPromptSession,
  loadSystemPrompt: () => CubeResult<string>,
  plannedThreadId: string,
) => {
  const snapshots = new Map<string, string>();
  let activeInstructions: string | undefined;

  const activate = (threadId: string, instructions: string): void => {
    snapshots.set(threadId, instructions);
    activeInstructions = instructions;
  };

  const prepare = async (): Promise<CubeResult<void>> => {
    const existingThreadId = session.thread.getId();

    if (existingThreadId) {
      const cachedInstructions = snapshots.get(existingThreadId);
      if (cachedInstructions) {
        activeInstructions = cachedInstructions;
        return { ok: true, value: undefined };
      }

      try {
        const storedInstructions = await session.thread.getSetting({
          key: SYSTEM_PROMPT_SETTING_KEY,
        });
        if (typeof storedInstructions === "string" && storedInstructions.trim()) {
          activate(existingThreadId, storedInstructions);
          return { ok: true, value: undefined };
        }
      } catch (cause) {
        return {
          ok: false,
          error: `Unable to read the thread system prompt: ${errorMessage(cause)}`,
        };
      }
    }

    const promptResult = loadSystemPrompt();
    if (!promptResult.ok) return promptResult;

    let createdThreadId: string | undefined;
    if (!existingThreadId) {
      try {
        createdThreadId = (await session.thread.create({ id: plannedThreadId })).id;
      } catch (cause) {
        return {
          ok: false,
          error: `Unable to create a thread: ${errorMessage(cause)}`,
        };
      }
    }

    try {
      await session.thread.setSetting({
        key: SYSTEM_PROMPT_SETTING_KEY,
        value: promptResult.value,
      });
    } catch (cause) {
      const persistenceError = errorMessage(cause);
      if (createdThreadId) {
        try {
          await session.thread.delete({ threadId: createdThreadId });
        } catch (cleanupCause) {
          return {
            ok: false,
            error: `Unable to save the thread system prompt: ${persistenceError}. Unable to remove the incomplete thread: ${errorMessage(cleanupCause)}`,
          };
        }
      }

      return {
        ok: false,
        error: `Unable to save the thread system prompt: ${persistenceError}`,
      };
    }

    const threadId = session.thread.getId();
    if (threadId) activate(threadId, promptResult.value);
    return {
      ok: true,
      value: undefined,
      ...(promptResult.warning ? { warning: promptResult.warning } : {}),
    };
  };

  const getInstructions = (): string => {
    if (!activeInstructions?.trim()) {
      throw new Error("Thread system prompt is unavailable.");
    }
    return activeInstructions;
  };

  return { prepare, getInstructions };
};
