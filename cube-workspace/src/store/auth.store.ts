import { readFile } from "node:fs/promises";
import type { HomeManager } from "../home-manager.js";
import {
  CubeAuthSchema,
  type ApiKeyProvider,
  type CubeAuth,
  type OpenAIOAuthCredential,
} from "../schemas/auth.schema.js";
import { atomicWriteFile } from "./atomic-write.js";

type AuthWriter = typeof atomicWriteFile;

export class AuthStore {
  // Serialize read/mutate/write per auth path inside this process, including refresh and account replacement.
  private static readonly updates = new Map<string, Promise<CubeAuth>>();
  constructor(
    private readonly home: HomeManager,
    private readonly writeFile: AuthWriter = atomicWriteFile,
  ) {}

  async read(): Promise<CubeAuth> {
    try {
      const raw = await readFile(this.home.getAuthPath(), "utf8");
      return CubeAuthSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error("Invalid Cube authentication file.");
    }
  }

  update(mutator: (current: CubeAuth) => CubeAuth): Promise<CubeAuth> {
    const authPath = this.home.getAuthPath();
    const next = (AuthStore.updates.get(authPath) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const auth = CubeAuthSchema.parse(mutator(await this.read()));
        await this.writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
        return auth;
      });
    AuthStore.updates.set(authPath, next);
    void next
      .finally(() => {
        if (AuthStore.updates.get(authPath) === next) AuthStore.updates.delete(authPath);
      })
      .catch(() => undefined);
    return next;
  }

  async getApiKey(provider: ApiKeyProvider): Promise<string | undefined> {
    return (await this.read()).api_keys[provider]?.api_key;
  }

  async getMcpValues(name: string, url: string): Promise<Record<string, string>> {
    const entry = (await this.read()).mcp[name];
    return entry?.url === new URL(url).href ? { ...entry.values } : {};
  }

  async updateMcpValues(
    name: string,
    url: string,
    mutate: (values: Record<string, string>) => Record<string, string>,
  ): Promise<void> {
    const canonical = new URL(url).href;
    await this.update((current) => {
      const entry = current.mcp[name];
      const values = mutate(entry?.url === canonical ? { ...entry.values } : {});
      return { ...current, mcp: { ...current.mcp, [name]: { url: canonical, values } } };
    });
  }

  async removeMcp(name: string): Promise<void> {
    await this.update((current) => {
      const mcp = { ...current.mcp };
      delete mcp[name];
      return { ...current, mcp };
    });
  }

  async replaceApiKey(provider: ApiKeyProvider, apiKey: string): Promise<void> {
    await this.update((current) => ({
      ...current,
      api_keys: {
        ...current.api_keys,
        [provider]: { api_key: apiKey },
      },
    }));
  }

  async getOpenAIOAuth(): Promise<OpenAIOAuthCredential | undefined> {
    return (await this.read()).oauth.openai;
  }

  async replaceOpenAIOAuth(credential: OpenAIOAuthCredential): Promise<void> {
    await this.update((current) => ({
      ...current,
      oauth: {
        ...current.oauth,
        openai: credential,
      },
    }));
  }
}
