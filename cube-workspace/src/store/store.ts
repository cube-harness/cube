import { readFile, appendFile, access } from "node:fs/promises";
import YAML from "yaml";
import { ZodType } from "zod";
import { atomicWriteFile, withFileLock } from "./atomic-write.js";
import { McpDocumentSchema, mcpConnectionKey, parseMcpConfig, type McpConfigSnapshot } from "../schemas/mcp.schema.js";
import { HomeManager } from "../home-manager.js";
import { ConfigSchema, type CubeConfigDocument } from "../schemas/config.schema.js";
import { ModelCatalogCache, ModelCatalogCacheSchema } from "../schemas/model-catalog.schema.js";
import { PermissionRegistry, PermissionRegistrySchema } from "../schemas/permission.schema.js";
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
  new Store<CubeConfigDocument>(home.getConfigPath(), "yaml", ConfigSchema);

export const McpStore = (home: HomeManager) => {
  const filePath = home.getMcpPath();
  const store = new Store<unknown>(filePath, "json");
  return {
    read: async (): Promise<McpConfigSnapshot> => {
      try { return parseMcpConfig(await store.read()); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseMcpConfig({ mcpServers: {} });
        return { servers: {}, errors: {}, error: error instanceof SyntaxError
          ? "Invalid mcp.json: malformed JSON."
          : "Cannot read mcp.json. Check its file permissions." };
      }
    },
    setDisabled: (name: string, disabled: boolean, expectedConnectionKey: string): Promise<McpConfigSnapshot> =>
      withFileLock(filePath, async () => {
        const document = McpDocumentSchema.parse(await store.read());
        const snapshot = parseMcpConfig(document);
        const server = snapshot.servers[name];
        if (!server || mcpConnectionKey(server) !== expectedConnectionKey)
          throw new Error("Server configuration changed. Run /reload before changing its enabled state.");
        document.mcpServers[name] = { ...(document.mcpServers[name] as Record<string, unknown>), disabled };
        await store.write(document);
        return parseMcpConfig(document);
      }),
  };
};

export const ModelCatalogStore = (home: HomeManager) =>
  new Store<ModelCatalogCache>(home.getModelCatalogPath(), "json", ModelCatalogCacheSchema);

export const PermissionStore = (home: HomeManager) =>
  new Store<PermissionRegistry>(home.getPermissionPath(), "json", PermissionRegistrySchema);

export const AgentsStore = (home: HomeManager) => new Store<string>(home.getAgentsPath(), "text");

export const SoulStore = (home: HomeManager, maxCharacters = home.getSoulMaxCharacters()) => {
  const soulPath = home.getSoulPath();
  const store = new Store<string>(home.getSoulPath(), "text");

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
    exists: async (): Promise<boolean> => {
      try {
        await access(soulPath);
        return true;
      } catch {
        return false;
      }
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
