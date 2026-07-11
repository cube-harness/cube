import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import { getMongoClient } from "@/config/database.js";
import { env } from "@/config/env.js";

let checkpointer: MongoDBSaver;

export async function getCheckpointer(): Promise<MongoDBSaver> {
  if (!checkpointer) {
    const client = await getMongoClient();
    checkpointer = new MongoDBSaver({
      client,
      dbName: env.MONGODB_DB,
      ttl: 60 * 60 * 24 * 7,
    });
    const errors = await checkpointer.setup();
    if (errors.length) console.error("Checkpointer setup errors:", errors);
  }
  return checkpointer;
}