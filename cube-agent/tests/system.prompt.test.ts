import assert from "node:assert/strict";
import test from "node:test";
import {
  createSystemPrompt,
  SYSTEM_PROMPT_SETTING_KEY,
} from "../src/prompts/system.prompt.js";

const PLANNED_THREAD_ID = "thread-planned";

interface FakeThreadState {
  currentId: string | null;
  createCount: number;
  deletedIds: string[];
  failSet: boolean;
  settings: Map<string, Map<string, unknown>>;
}

const createFakeSession = () => {
  const state: FakeThreadState = {
    currentId: null,
    createCount: 0,
    deletedIds: [],
    failSet: false,
    settings: new Map(),
  };

  const requireSettings = (): Map<string, unknown> => {
    if (!state.currentId) throw new Error("No active thread.");
    const settings = state.settings.get(state.currentId);
    if (!settings) throw new Error(`Unknown thread: ${state.currentId}`);
    return settings;
  };

  const session = {
    thread: {
      getId: () => state.currentId,
      getSetting: async ({ key }: { key: string }) => requireSettings().get(key),
      setSetting: async ({ key, value }: { key: string; value: unknown }) => {
        if (state.failSet) throw new Error("storage unavailable");
        requireSettings().set(key, value);
      },
      create: async ({ id }: { id?: string } = {}) => {
        state.createCount += 1;
        const createdId = id ?? `thread-${state.createCount}`;
        state.settings.set(createdId, new Map());
        state.currentId = createdId;
        return { id: createdId };
      },
      delete: async ({ threadId }: { threadId: string }) => {
        state.deletedIds.push(threadId);
        state.settings.delete(threadId);
        if (state.currentId === threadId) state.currentId = null;
      },
    },
  };

  const addThread = (threadId: string, instructions?: string): void => {
    const settings = new Map<string, unknown>();
    if (instructions !== undefined) {
      settings.set(SYSTEM_PROMPT_SETTING_KEY, instructions);
    }
    state.settings.set(threadId, settings);
    state.currentId = threadId;
  };

  return { session, state, addThread };
};

test("invalid system prompt does not create a thread", async () => {
  const fake = createFakeSession();
  const systemPrompt = createSystemPrompt(fake.session, () => ({
    ok: false,
    error: "SOUL.md exceeds the configured limit.",
  }), PLANNED_THREAD_ID);

  const result = await systemPrompt.prepare();

  assert.equal(result.ok, false);
  assert.equal(fake.state.createCount, 0);
  assert.equal(fake.state.currentId, null);
});

test("the first valid prompt creates one thread and persists its system prompt", async () => {
  const fake = createFakeSession();
  const systemPrompt = createSystemPrompt(fake.session, () => ({
    ok: true,
    value: "first instructions",
  }), PLANNED_THREAD_ID);

  const result = await systemPrompt.prepare();

  assert.equal(result.ok, true);
  assert.equal(fake.state.createCount, 1);
  assert.equal(
    fake.state.settings.get(PLANNED_THREAD_ID)?.get(SYSTEM_PROMPT_SETTING_KEY),
    "first instructions",
  );
  assert.equal(systemPrompt.getInstructions(), "first instructions");
});

test("later preparation reuses the active thread snapshot", async () => {
  const fake = createFakeSession();
  let loadCount = 0;
  const systemPrompt = createSystemPrompt(fake.session, () => {
    loadCount += 1;
    return { ok: true, value: "captured once" };
  }, PLANNED_THREAD_ID);

  await systemPrompt.prepare();
  await systemPrompt.prepare();

  assert.equal(loadCount, 1);
  assert.equal(fake.state.createCount, 1);
  assert.equal(systemPrompt.getInstructions(), "captured once");
});

test("switching to an old thread activates its stored system prompt", async () => {
  const fake = createFakeSession();
  fake.addThread("old-thread", "old instructions");
  let loadCount = 0;
  const systemPrompt = createSystemPrompt(fake.session, () => {
    loadCount += 1;
    return { ok: true, value: "new instructions" };
  }, PLANNED_THREAD_ID);

  const result = await systemPrompt.prepare();

  assert.equal(result.ok, true);
  assert.equal(loadCount, 0);
  assert.equal(systemPrompt.getInstructions(), "old instructions");
});

test("a legacy thread captures the system prompt exactly once", async () => {
  const fake = createFakeSession();
  fake.addThread("legacy-thread");
  let loadCount = 0;
  const systemPrompt = createSystemPrompt(fake.session, () => {
    loadCount += 1;
    return { ok: true, value: "legacy snapshot" };
  }, PLANNED_THREAD_ID);

  await systemPrompt.prepare();
  await systemPrompt.prepare();

  assert.equal(loadCount, 1);
  assert.equal(
    fake.state.settings.get("legacy-thread")?.get(SYSTEM_PROMPT_SETTING_KEY),
    "legacy snapshot",
  );
});

test("a persistence failure deletes the newly created thread", async () => {
  const fake = createFakeSession();
  fake.state.failSet = true;
  const systemPrompt = createSystemPrompt(fake.session, () => ({
    ok: true,
    value: "instructions",
  }), PLANNED_THREAD_ID);

  const result = await systemPrompt.prepare();

  assert.equal(result.ok, false);
  assert.deepEqual(fake.state.deletedIds, [PLANNED_THREAD_ID]);
  assert.equal(fake.state.currentId, null);
  assert.equal(fake.state.settings.size, 0);
});

test("the active system prompt survives metadata changes during a run", async () => {
  const fake = createFakeSession();
  const systemPrompt = createSystemPrompt(fake.session, () => ({
    ok: true,
    value: "stable instructions",
  }), PLANNED_THREAD_ID);
  await systemPrompt.prepare();
  fake.state.settings.get(PLANNED_THREAD_ID)?.delete(SYSTEM_PROMPT_SETTING_KEY);

  assert.equal(systemPrompt.getInstructions(), "stable instructions");
});

test("instructions are unavailable before a thread prompt is prepared", () => {
  const fake = createFakeSession();
  const systemPrompt = createSystemPrompt(fake.session, () => ({
    ok: true,
    value: "instructions",
  }), PLANNED_THREAD_ID);

  assert.throws(
    () => systemPrompt.getInstructions(),
    /Thread system prompt is unavailable/,
  );
});
