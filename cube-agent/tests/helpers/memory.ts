import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LibSQLStore } from "@mastra/libsql";
import type { MastraDBMessage } from "@mastra/core/agent";
import { HomeManager, createMemoryStore } from "@cube/workspace";

export async function memoryFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cube-durable-test-"));
  const home = new HomeManager({ cubeHome: root });
  const database = new LibSQLStore({ id: "memory-test", url: `file:${path.join(root, "test.sqlite")}` });
  await database.init();
  const storage = (await database.getStore("memory"))!;
  const store = createMemoryStore(home, root);
  async function thread(id: string, resourceId = root, count = 4) {
    const date = new Date(Date.now() - 24 * 3_600_000);
    await storage.saveThread({ thread: { id, resourceId, title: "Public storage decisions", createdAt: date, updatedAt: date } });
    const messages: MastraDBMessage[] = Array.from({ length: count }, (_, index) => ({
      id: `${id}-${index}`, threadId: id, resourceId, createdAt: new Date(date.getTime() + index),
      role: index % 2 ? "assistant" : "user",
      content: { format: 2, parts: [{ type: "text", text: `Public storage APIs avoid private methods. ${"Verified lesson. ".repeat(30)}` }] },
    }));
    await storage.saveMessages({ messages });
    return messages;
  }
  return { root, home, store, storage, thread, close: async () => {
    await database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } };
}
