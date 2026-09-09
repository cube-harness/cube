import {
  OpenAIOAuthCredentialSchema,
  type AuthStore,
  type OpenAIOAuthCredential,
  type GrokOAuthCredential,
  type AnthropicOAuthCredential,
} from "@cube/workspace";
import type { OpenAIOAuthCredentialProvider } from "@cube/agent";
import {
  beginOpenAILogin,
  refreshOpenAICredential,
  type OpenAILoginHandle,
  type OpenAIOAuthOptions,
} from "./openai.js";
import { beginGrokLogin, refreshGrokCredential, type GrokOAuthOptions } from "./grok.js";
import { beginAnthropicLogin, refreshAnthropicCredential, type AnthropicOAuthOptions } from "./anthropic.js";

type OpenAIAuthStore = Pick<AuthStore, "read" | "update">;

export class OpenAIAuthManager implements OpenAIOAuthCredentialProvider {
  private pendingCredential?: Promise<OpenAIOAuthCredential>;
  constructor(
    private readonly store: OpenAIAuthStore,
    private readonly options: OpenAIOAuthOptions = {},
  ) {}

  beginLogin(signal?: AbortSignal): Promise<OpenAILoginHandle> {
    return beginOpenAILogin(this.options, signal);
  }

  async commitOpenAIOAuth(credential: OpenAIOAuthCredential): Promise<void> {
    await this.store.update((auth) => ({
      ...auth,
      oauth: {
        ...auth.oauth,
        openai: OpenAIOAuthCredentialSchema.parse(credential),
      },
    }));
  }

  getValidCredential(): Promise<OpenAIOAuthCredential> {
    this.pendingCredential ??= this.readAndRefresh().finally(() => {
      this.pendingCredential = undefined;
    });
    return this.pendingCredential;
  }

  private async readAndRefresh(): Promise<OpenAIOAuthCredential> {
    const current = (await this.store.read()).oauth.openai;
    if (!current) {
      throw new Error("OpenAI OAuth is not configured. Run /gateway to sign in.");
    }

    const now = (this.options.now ?? Date.now)();
    if (current.expires_at > now + 5 * 60_000) return current;

    const refreshed = await refreshOpenAICredential(current, this.options.fetch, this.options.now);
    const saved = await this.store.update((auth) => {
      if (JSON.stringify(auth.oauth.openai) !== JSON.stringify(current))
        throw new Error("OpenAI credential changed. Run /gateway again.");
      return { ...auth, oauth: { ...auth.oauth, openai: refreshed } };
    });
    return saved.oauth.openai!;
  }
}

export { OpenAIAuthManager as AuthManager };

export class AnthropicAuthManager {
  private pendingCredential?: Promise<AnthropicOAuthCredential>;
  constructor(
    private readonly store: Pick<AuthStore, "read" | "update">,
    private readonly options: AnthropicOAuthOptions = {},
  ) {}

  beginLogin(signal?: AbortSignal) {
    return beginAnthropicLogin(this.options, signal);
  }

  getValidCredential(): Promise<AnthropicOAuthCredential> {
    this.pendingCredential ??= this.readAndRefresh().finally(() => { this.pendingCredential = undefined; });
    return this.pendingCredential;
  }

  private async readAndRefresh(): Promise<AnthropicOAuthCredential> {
    const current = (await this.store.read()).oauth.anthropic;
    if (!current) throw new Error("Anthropic OAuth is not configured. Run /gateway to sign in.");
    if (current.expires_at > (this.options.now ?? Date.now)() + 5 * 60_000) return current;
    const refreshed = await refreshAnthropicCredential(current, this.options);
    const saved = await this.store.update((auth) => {
      if (JSON.stringify(auth.oauth.anthropic) !== JSON.stringify(current))
        throw new Error("Anthropic credential changed. Run /gateway again.");
      return { ...auth, oauth: { ...auth.oauth, anthropic: refreshed } };
    });
    return saved.oauth.anthropic!;
  }
}

export class GrokAuthManager {
  private pendingCredential?: Promise<GrokOAuthCredential>;
  constructor(
    private readonly store: Pick<AuthStore, "read" | "update">,
    private readonly options: GrokOAuthOptions = {},
  ) {}

  beginLogin(signal?: AbortSignal) {
    return beginGrokLogin(this.options, signal);
  }

  getValidCredential(): Promise<GrokOAuthCredential> {
    this.pendingCredential ??= this.readAndRefresh().finally(() => {
      this.pendingCredential = undefined;
    });
    return this.pendingCredential;
  }

  private async readAndRefresh(): Promise<GrokOAuthCredential> {
    const current = (await this.store.read()).oauth.xai;
    if (!current) throw new Error("Grok Build is not configured. Run /gateway to sign in.");
    if (current.expires_at > (this.options.now ?? Date.now)() + 5 * 60_000) return current;
    const refreshed = await refreshGrokCredential(current, this.options);
    const saved = await this.store.update((auth) => {
      // A login/account replacement must not be overwritten by an older in-flight refresh.
      if (JSON.stringify(auth.oauth.xai) !== JSON.stringify(current))
        throw new Error("xAI credential changed. Run /gateway again.");
      return { ...auth, oauth: { ...auth.oauth, xai: refreshed } };
    });
    if (!saved.oauth.xai) throw new Error("Grok Build is not configured. Run /gateway to sign in.");
    return saved.oauth.xai;
  }
}
