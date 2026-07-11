import { MongoDBStore } from "@langchain/langgraph-checkpoint-mongodb";
import { getMongoClient } from "@/config/database.js";
import { env } from "@/config/env.js";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";

let store: MongoDBStore;

export async function getStore(): Promise<MongoDBStore> {
  if (!store) {
    const client = await getMongoClient();
    store = new MongoDBStore({
      client,
      dbName: env.MONGODB_DB,
      collectionName: "long_term_memory",
      enableTimestamps: true,
      embeddings: new GoogleGenerativeAIEmbeddings({
        model: "text-embedding-004",
        apiKey: env.GEMINI_API_KEY
      }),
      indexConfig: {
        name: "memory_vector_index",
        dims: 768,
        similarityFunction: "cosine",
        embeddingKey: "embedding", 
      },
    });
    await store.start();
  }
  
  return store;
}
