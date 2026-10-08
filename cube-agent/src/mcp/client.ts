import { createHash, randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { MCPClient, MCPOAuthClientProvider, type OAuthStorage, type OAuthClientProvider } from "@mastra/mcp";
import { noopLogger } from "@mastra/core/logger";
import {
  AuthStore, MCP_DEFAULTS, mcpConnectionKey,
  type McpConfigSnapshot, type McpServerConfig,
} from "@cube/workspace";

export type McpTools = Awaited<ReturnType<MCPClient["listTools"]>>;
export type McpStatus = "connected" | "disabled" | "connecting" | "needs-auth" | "error";
export type McpToolChoice = { name: string; description: string };
export type McpServerState = {
  name: string;
  transport: "stdio" | "http";
  status: McpStatus;
  tools: McpToolChoice[];
  error?: string;
  endpoint?: string;
  command?: string;
  oauth: boolean;
  canLogout: boolean;
};
export type McpState = { servers: McpServerState[]; error?: string };
export type McpLogin = {
  authorizationUrl: string;
  expiresAt: number;
  completion: Promise<void>;
  cancel(): Promise<void>;
};
export type BeforeMcpPublish = (toolNames: string[]) => Promise<void>;

// The exported base declares this protected extension point; no private registration calls.
class QuietMcpClient extends MCPClient {
  constructor(options: ConstructorParameters<typeof MCPClient>[0]) {
    super(options);
    // Diagnostics live in the picker. Native log strings can contain credential values.
    this.logger = noopLogger;
  }
}

// SDK v2's public optional hooks bind the callback to the discovered authorization server.
// The discovery pin has the same lifetime as the in-memory PKCE verifier.
class CubeMcpOAuthProvider extends MCPOAuthClientProvider {
  private discovery?: Parameters<NonNullable<OAuthClientProvider["saveDiscoveryState"]>>[0];
  saveDiscoveryState(state: NonNullable<typeof this.discovery>): void { this.discovery = structuredClone(state); }
  discoveryState(): typeof this.discovery { return this.discovery; }
  override async clientInformation(context?: Parameters<OAuthClientProvider["clientInformation"]>[0]) {
    const info = await super.clientInformation();
    // Bind newly configured clients to the SDK's discovered issuer before its stamp check.
    if (info && context && !("issuer" in info)) {
      const stamped = { ...this.clientMetadata, ...info, issuer: context.issuer };
      await this.saveClientInformation(stamped);
      return stamped;
    }
    return info;
  }
  override endAuthorizationSession(): void { super.endAuthorizationSession(); this.discovery = undefined; }
}

type Server = {
  config: McpServerConfig;
  key: string;
  state: McpServerState;
  tools: McpTools;
  client?: MCPClient;
  provider?: MCPOAuthClientProvider;
  active: boolean;
  generation: number;
  flow?: Promise<void>;
  loginPending?: boolean;
  deliverUrl?: (url: string) => void;
};

export class CubeMcp {
  private readonly servers = new Map<string, Server>();
  private readonly listeners = new Set<() => void>();
  private tools: McpTools = {};
  private error?: string;
  private closing = false;
  private disposed?: Promise<void>;

  constructor(private readonly options: {
    auth: AuthStore;
    workspaceRoot: string;
  }) {}

  get(): McpState {
    return { servers: [...this.servers.values()].map(({ state }) => structuredClone(state))
      .sort((a, b) => a.name.localeCompare(b.name)), ...(this.error ? { error: this.error } : {}) };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  readTools(serverNames?: readonly string[]): McpTools {
    if (!serverNames) return { ...this.tools };
    const allowed = new Set(serverNames.flatMap(name => Object.keys(this.server(name).tools)));
    return Object.fromEntries(Object.entries(this.tools).filter(([name]) => allowed.has(name)));
  }
  readToolNames(serverNames?: readonly string[]): string[] { return Object.keys(this.readTools(serverNames)); }
  getConnectionKey(name: string): string { return this.server(name).key; }

  private changed(): void { for (const listener of this.listeners) listener(); }
  private server(name: string): Server {
    const server = this.servers.get(name);
    if (!server) throw new Error("MCP server is no longer configured. Run /reload.");
    return server;
  }

  private safe(text: string, config?: McpServerConfig): string {
    let value = stripVTControlCharacters(text);
    if (config) {
      const secrets = config.type === "stdio"
        ? [...Object.values(config.env), ...config.args]
        : [...Object.values(config.headers).flatMap(header => [header, header.replace(/^(?:Bearer|Basic)\s+/i, "")]),
          ...(config.oauth ? [config.oauth.client_id, config.oauth.client_secret ?? "",
            Buffer.from(`${config.oauth.client_id}:${config.oauth.client_secret ?? ""}`).toString("base64")] : []),
          ...new URL(config.url).searchParams.values(), new URL(config.url).username, new URL(config.url).password];
      for (const secret of secrets.filter(Boolean)) value = value.split(secret).join("[Redacted]");
    }
    return value.slice(0, 2000);
  }

  private fail(server: Server, error: unknown): void {
    server.tools = {};
    server.state.tools = [];
    server.state.status = server.client?.getServerAuthState(server.state.name) === "needs-auth"
      ? "needs-auth" : "error";
    server.state.error = this.safe(error instanceof Error ? error.message : String(error), server.config);
    this.dropTools();
    this.changed();
  }

  // Removal cannot introduce an unapproved tool; only publication adds new names.
  private dropTools(): void {
    const live = new Set([...this.servers.values()].flatMap((server) => Object.keys(server.tools)));
    this.tools = Object.fromEntries(Object.entries(this.tools).filter(([name]) => live.has(name)));
  }

  private makeServer(name: string, config: McpServerConfig): Server {
    const state: McpServerState = {
      name: stripVTControlCharacters(name), transport: config.type,
      status: config.disabled ? "disabled" : "connecting", tools: [], oauth: false, canLogout: false,
      ...(config.type === "stdio" ? { command: config.command } : {
        endpoint: `${new URL(config.url).origin}${new URL(config.url).pathname}`,
      }),
    };
    return { config, key: mcpConnectionKey(config), state, tools: {}, active: true, generation: 0 };
  }

  private async createClient(name: string, server: Server): Promise<void> {
    if (!server.active || this.closing) throw new Error("MCP operation was cancelled.");
    if (server.client) return;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Server name must contain only letters, numbers, hyphens or underscores for tool names.");
    const config = server.config;
    const base = { timeout: config.timeout, forwardInstructions: false, enableServerLogs: false };
    if (config.type === "stdio") {
      server.client = new QuietMcpClient({ id: randomUUID(), servers: {
        [name]: { ...base, command: config.command, args: config.args,
          env: config.env, cwd: config.cwd ?? this.options.workspaceRoot, stderr: "ignore" },
      } });
      return;
    }
    const eligible = !Object.keys(config.headers).some((key) => key.toLowerCase() === "authorization");
    if (eligible) {
      // Credentials for another configured OAuth client must never be reused.
      const clientKey = config.oauth ? createHash("sha256").update(JSON.stringify(config.oauth)).digest("hex") : undefined;
      const scoped = (values: Record<string, string>) => values.oauth_client === clientKey ? values : {};
      const initial = await this.options.auth.getMcpValues(name, config.url);
      if (!server.active || this.closing) throw new Error("MCP operation was cancelled.");
      server.state.canLogout = Object.keys(initial).length > 0;
      let verifier: string | undefined;
      const current = () => server.active && !this.closing && this.servers.get(name) === server;
      const storage: OAuthStorage = {
        get: async (key) => key === "code_verifier" ? verifier
          : current() ? scoped(await this.options.auth.getMcpValues(name, config.url))[key] : undefined,
        set: async (key, value) => {
          if (!current()) throw new Error("MCP authentication was cancelled.");
          if (key === "code_verifier") { verifier = value; return; }
          await this.options.auth.updateMcpValues(name, config.url, (values) => {
            if (!current()) throw new Error("MCP authentication was cancelled.");
            return { ...scoped(values), ...(clientKey ? { oauth_client: clientKey } : {}), [key]: value };
          });
          server.state.canLogout = true;
        },
        delete: async (key) => {
          if (key === "code_verifier") { verifier = undefined; return; }
          if (!current()) return;
          await this.options.auth.updateMcpValues(name, config.url, (values) => {
            if (!current()) throw new Error("MCP authentication was cancelled.");
            delete values[key];
            return values;
          });
        },
      };
      server.provider = new CubeMcpOAuthProvider({
        redirectUrl: "http://127.0.0.1:1466/oauth/callback",
        clientMetadata: { client_name: "Cube", redirect_uris: ["http://127.0.0.1:1466/oauth/callback"],
          grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
        clientInformation: config.oauth,
        storage,
        onRedirectToAuthorization: (url) => { server.deliverUrl?.(url.href); },
      });
      server.state.oauth = true;
    }
    server.client = new QuietMcpClient({ id: randomUUID(), servers: {
      [name]: { ...base, url: new URL(config.url), requestInit: { headers: config.headers },
        connectTimeout: config.connectTimeout, ...(server.provider ? { authProvider: server.provider } : {}) },
    } });
  }

  private async discover(name: string, server: Server): Promise<void> {
    const generation = ++server.generation;
    server.state.status = "connecting";
    delete server.state.error;
    this.changed();
    try {
      await this.createClient(name, server);
      if (!server.active || this.closing) throw new Error("MCP authentication was cancelled.");
      const result = await server.client!.listToolsWithErrors({ perServerTimeoutMs: server.config.timeout });
      if (!server.active || this.closing || server.generation !== generation) return;
      const error = result.errors[name];
      if (error) throw new Error(error);
      if (Object.keys(result.tools).some((tool) => !/^[A-Za-z0-9_-]{1,64}$/.test(tool)))
        throw new Error("Server exposes a tool name incompatible with model tool identifiers (maximum 64 characters).");
      server.tools = result.tools;
      server.state.tools = Object.entries(result.tools).map(([tool, value]) => ({
        name: tool, description: this.safe(value.description ?? "", server.config),
      }));
      server.state.status = "connected";
    } catch (error) {
      if (server.active && !this.closing && server.generation === generation) this.fail(server, error);
    }
    this.changed();
  }

  private async publish(beforePublish: BeforeMcpPublish): Promise<void> {
    if (this.closing) return;
    const candidates: McpTools = {};
    const owners = new Map<string, Server>();
    for (const server of this.servers.values()) {
      for (const [name, tool] of Object.entries(server.tools)) {
        const owner = owners.get(name);
        if (owner) {
          this.fail(owner, new Error(`MCP tool name collision: ${name}`));
          this.fail(server, new Error(`MCP tool name collision: ${name}`));
          delete candidates[name];
        } else { candidates[name] = tool; owners.set(name, server); }
      }
    }
    const sorted = Object.fromEntries(Object.entries(candidates).filter(([name]) => owners.get(name)?.tools[name])
      .sort(([a], [b]) => a.localeCompare(b)));
    try {
      await beforePublish(Object.keys(sorted));
      if (!this.closing) this.tools = sorted;
    } catch (error) {
      for (const server of this.servers.values()) if (server.state.status === "connected") this.fail(server, error);
      this.error = this.safe(error instanceof Error ? error.message : String(error));
    }
    this.changed();
  }

  private async retire(server: Server): Promise<void> {
    server.active = false;
    server.generation++;
    server.tools = {};
    server.state.tools = [];
    this.dropTools();
    try { await server.client?.cancelAuthentication(server.state.name); }
    finally { await server.client?.disconnect(); }
  }

  async reload(snapshot: McpConfigSnapshot, beforePublish: BeforeMcpPublish): Promise<void> {
    this.error = snapshot.error;
    if (snapshot.error) { this.changed(); return; }
    const connect: Array<[string, Server]> = [];
    for (const [name, server] of this.servers) {
      const next = snapshot.servers[name];
      if (!next || server.key !== mcpConnectionKey(next) || server.config.disabled !== next.disabled) {
        await this.retire(server).catch((error) => this.fail(server, error));
        this.servers.delete(name);
      }
    }
    for (const [name, config] of Object.entries(snapshot.servers)) {
      if (this.servers.has(name)) continue;
      const server = this.makeServer(name, config);
      this.servers.set(name, server);
      if (!config.disabled) connect.push([name, server]);
    }
    for (const [name, error] of Object.entries(snapshot.errors)) {
      const server = this.makeServer(name, { type: "stdio", command: "", args: [], env: {},
        disabled: true, timeout: MCP_DEFAULTS.REQUEST_TIMEOUT_MS });
      server.state.status = "error";
      server.state.error = this.safe(error);
      this.servers.set(name, server);
    }
    await Promise.all(connect.map(([name, server]) => this.discover(name, server)));
    await this.publish(beforePublish);
  }

  async restart(name: string, beforePublish: BeforeMcpPublish): Promise<void> {
    const server = this.server(name);
    if (server.config.disabled) throw new Error("Enable this server before restarting it.");
    server.tools = {};
    server.state.tools = [];
    this.dropTools();
    try {
      await this.createClient(name, server);
      await server.client!.reconnectServer(name);
    } catch (error) { this.fail(server, error); return; }
    await this.discover(name, server);
    await this.publish(beforePublish);
  }

  async beginLogin(name: string, beforePublish: BeforeMcpPublish): Promise<McpLogin> {
    const server = this.server(name);
    if (server.config.disabled) throw new Error("Enable this server before signing in.");
    server.loginPending = true;
    try {
      await this.createClient(name, server);
      if (!server.active || this.closing) throw new Error("MCP authentication was cancelled.");
      if (!server.provider) throw new Error("This server uses manually configured credentials, not OAuth.");
      if (server.state.status === "connected") throw new Error("Log out before signing into another account.");
    }
    catch (error) { server.loginPending = false; throw error; }
    let deliver!: (url: string) => void;
    let rejectUrl!: (error: unknown) => void;
    const url = new Promise<string>((resolve, reject) => { deliver = resolve; rejectUrl = reject; });
    server.deliverUrl = deliver;
    const expiresAt = Date.now() + MCP_DEFAULTS.AUTH_TIMEOUT_MS;
    const completion = (async () => {
      try {
        await server.client!.authenticate(name, { timeoutMs: MCP_DEFAULTS.AUTH_TIMEOUT_MS });
        if (!server.active || this.closing) throw new Error("MCP authentication was cancelled.");
        await this.discover(name, server);
        if (server.state.status !== "connected") throw new Error(server.state.error ?? "MCP authentication did not connect the server.");
        await this.publish(beforePublish);
        if (server.state.status !== "connected") throw new Error(server.state.error ?? "MCP tools could not be published.");
        rejectUrl(new Error("Server is already authenticated. Restart it to refresh tools."));
      } catch (error) {
        const failure = new Error(this.safe(error instanceof Error ? error.message : String(error), server.config));
        rejectUrl(failure);
        if (server.active && !this.closing) this.fail(server, failure);
        throw failure;
      } finally {
        server.loginPending = false;
        server.deliverUrl = undefined;
        await server.provider?.invalidateCredentials("verifier");
      }
    })();
    server.flow = completion;
    // The picker receives completion after the URL, but setup may fail before that.
    void completion.catch(() => undefined);
    return { authorizationUrl: await url, expiresAt, completion, cancel: () => this.cancelLogin(name) };
  }

  async cancelLogin(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server || (!server.loginPending && !server.flow)) return;
    await this.retire(server);
    await server.flow?.catch(() => undefined);
    if (this.closing || this.servers.get(name) !== server) return;
    const replacement = this.makeServer(name, server.config);
    replacement.state.status = "needs-auth";
    replacement.state.oauth = true;
    replacement.state.canLogout = server.state.canLogout;
    this.servers.set(name, replacement);
    this.changed();
  }

  async logout(name: string, beforePublish: BeforeMcpPublish): Promise<void> {
    const server = this.server(name);
    try {
      await this.retire(server);
      await server.flow?.catch(() => undefined);
      await server.provider?.clear();
      await this.options.auth.removeMcp(name);
      const replacement = this.makeServer(name, server.config);
      replacement.state.status = server.config.disabled ? "disabled" : "needs-auth";
      replacement.state.oauth = server.config.type === "http";
      this.servers.set(name, replacement);
      await this.publish(beforePublish);
    } catch (error) { this.fail(server, error); throw error; }
  }

  dispose(): Promise<void> {
    this.disposed ??= (async () => {
      this.closing = true;
      this.tools = {};
      await Promise.allSettled([...this.servers.values()].map(async (server) => {
        await this.retire(server);
        await server.flow?.catch(() => undefined);
      }));
      this.listeners.clear();
    })();
    return this.disposed;
  }
}
