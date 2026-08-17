import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentModelList,
  prepareSessionForFreshProcess,
} from "../src/index.js";

const createFakeSession = (messages: unknown[]) => {
  let currentThreadId: string | null = "thread-existing";
  let detachCount = 0;
  let releaseCount = 0;
  const deletedIds: string[] = [];

  return {
    session: {
      thread: {
        getId: () => currentThreadId,
        listActiveMessages: async () => messages,
        detachFromCurrent: () => {
          detachCount += 1;
        },
        clearAndReleaseLock: async () => {
          releaseCount += 1;
          currentThreadId = null;
        },
        delete: async ({ threadId }: { threadId: string }) => {
          deletedIds.push(threadId);
          if (currentThreadId === threadId) currentThreadId = null;
        },
      },
    },
    snapshot: () => ({
      currentThreadId,
      detachCount,
      releaseCount,
      deletedIds,
    }),
  };
};

test("a new process detaches from a populated thread without deleting it", async () => {
  const fake = createFakeSession([{ id: "message-existing" }]);

  await prepareSessionForFreshProcess(fake.session);

  assert.deepEqual(fake.snapshot(), {
    currentThreadId: null,
    detachCount: 1,
    releaseCount: 1,
    deletedIds: [],
  });
});

test("a new process removes Mastra's empty bootstrap thread", async () => {
  const fake = createFakeSession([]);

  await prepareSessionForFreshProcess(fake.session);

  assert.deepEqual(fake.snapshot(), {
    currentThreadId: null,
    detachCount: 0,
    releaseCount: 0,
    deletedIds: ["thread-existing"],
  });
});

test("interactive provider options apply only to the primary model", () => {
  const models = createAgentModelList({
    active: {
      selection: {
        modelId: "google/gemini-3.6-flash",
        config: { reasoning_effort: "high" },
      },
      providerOptions: {
        google: { thinkingConfig: { thinkingLevel: "high" } },
      },
    },
    fallbackModel: "openai/gpt-5.1",
    resolveModel: (modelId) => modelId,
  });

  assert.equal(models.length, 2);
  assert.deepEqual(models[0], {
    model: "google/gemini-3.6-flash",
    maxRetries: 2,
    providerOptions: {
      google: { thinkingConfig: { thinkingLevel: "high" } },
    },
  });
  assert.deepEqual(models[1], {
    model: "openai/gpt-5.1",
    maxRetries: 1,
  });
});

test("fallback is omitted when it matches the active model", () => {
  const models = createAgentModelList({
    active: {
      selection: { modelId: "openai/gpt-5.1", config: {} },
    },
    fallbackModel: "openai/gpt-5.1",
    resolveModel: (modelId) => modelId,
  });

  assert.deepEqual(models, [{ model: "openai/gpt-5.1", maxRetries: 2 }]);
});
