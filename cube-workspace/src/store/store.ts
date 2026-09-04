import { readFile, appendFile } from "node:fs/promises";
import YAML from "yaml";
import { ZodType } from "zod";
import { atomicWriteFile } from "./atomic-write.js";
import { HomeManager } from "../home-manager.js";
import { ConfigSchema, CubeConfig } from "../schemas/config.schema.js";
import { ModelCatalog, ModelCatalogSchema } from "../schemas/model-catalog.schema.js";
import { WorkspaceRegistry, WorkspaceRegistrySchema } from "../schemas/workspace.schema.js";
import { History, HistoryEntry, HistorySchema } from "../schemas/history.schema.js";

type Format = "text" | "yaml" | "json";

const parseByFormat = <T>(format: Format, raw: string): T => {
  if (format === "json") return JSON.parse(raw) as T;
  if (format === "yaml") return YAML.parse(raw) as T;
  return raw as T;
};

const stringifyByFormat = <T>(format: Format, data: T): string => {
  if (format === "json") return JSON.stringify(data, null, 2);
  if (format === "yaml") return YAML.stringify(data);
  return data as unknown as string;
};

export class Store<T> {
  constructor(
    private readonly filePath: string,
    private readonly format: Format,
    private readonly schema?: ZodType<T>,
  ) {}

  async read(): Promise<T> {
    const raw = await readFile(this.filePath, "utf-8");
    const parsed = parseByFormat<T>(this.format, raw);
    return this.schema ? this.schema.parse(parsed) : parsed;
  }
  async write(data: T): Promise<void> {
    const validated = this.schema ? this.schema.parse(data) : data;
    await atomicWriteFile(this.filePath, stringifyByFormat(this.format, validated));
  }
  async update(mutator: (current: T) => T): Promise<T> {
    const next = mutator(await this.read());
    await this.write(next);
    return next;
  }
}

export const ConfigStore = (home: HomeManager) =>
  new Store<CubeConfig>(home.getConfigPath(), "yaml", ConfigSchema);

export const ModelCatalogStore = (home: HomeManager) =>
  new Store<ModelCatalog>(home.getModelCatalogPath(), "json", ModelCatalogSchema);

export const WorkspaceRegistryStore = (home: HomeManager) =>
  new Store<WorkspaceRegistry>(home.getWorkspacePath(), "json", WorkspaceRegistrySchema);

export const AgentsStore = (home: HomeManager) =>
  new Store<string>(home.getAgentsPath(), "text");

export const SoulStore = (home: HomeManager) => {
  const store = new Store<string>(home.getSoulPath(), "text");
  const maxCharacters = home.getSoulMaxCharacters();

  const validateCharacters = (content: string): void => {
    if (content.length > maxCharacters) {
      throw new Error(`SOUL.md exceeds max length (${content.length}/${maxCharacters} characters)`);
    }
  };

  return {
    validateCharacters,
    read: async (): Promise<string> => {
      const content = await store.read();
      validateCharacters(content);
      return content;
    },
    write: async (content: string): Promise<void> => {
      validateCharacters(content);
      await store.write(content);
    },
  };
};

export const HistoryStore = (home: HomeManager) => {
  const store = new Store<string>(home.getHistoryPath(), "text");

  return {
    read: async (): Promise<History> => {
      try {
        const raw = await store.read();
        const entries = raw
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        return HistorySchema.parse(entries);
      } catch {
        return [];
      }
    },
    append: async (entry: HistoryEntry): Promise<void> => {
      await appendFile(home.getHistoryPath(), `${JSON.stringify(entry)}\n`, "utf-8");
    },
  };
};
