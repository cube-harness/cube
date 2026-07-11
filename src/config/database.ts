import { MongoClient, Db } from "mongodb";
import { env } from "@/config/env.js";

let client: MongoClient;
let db: Db;

export async function getMongoClient(): Promise<MongoClient> {
  if (!client) {
    const newClient = new MongoClient(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    try {
      await newClient.connect();
      client = newClient;
      db = client.db(env.MONGODB_DB);
    } catch (err) {
      console.error("MongoDB connection failed:", err);
      throw err;
    }
  }
  return client;
}

export async function getDatabase(): Promise<Db> {
  if (!db) {
    await getMongoClient();
  }
  return db;
}

export async function getCollection(name: string) {
  const database = await getDatabase();
  return database.collection(name);
}