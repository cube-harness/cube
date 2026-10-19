import { type CubeMcp, type McpState, type McpLogin, type BeforeMcpPublish } from "@cube/agent";
import { type McpStore } from "@cube/workspace";

export class McpService {
  private applying = false;
  private closing = false;
  private loginName?: string;
  private cancelling = false;

  constructor(private readonly options: {
    store: ReturnType<typeof McpStore>;
    client: CubeMcp;
    isBusy(): boolean;
    beforePublish: BeforeMcpPublish;
  }) {}

  get(): McpState { return this.options.client.get(); }
  subscribe(listener: () => void): () => void { return this.options.client.subscribe(listener); }
  isApplying(): boolean { return this.applying; }

  private enter(): void {
    if (this.closing || this.applying || this.options.isBusy())
      throw new Error("Finish or cancel the current operation before changing MCP connections.");
    this.applying = true;
  }

  private async mutate(operation: () => Promise<void>): Promise<void> {
    this.enter();
    try { await operation(); }
    finally { this.applying = false; }
  }

  private publish: BeforeMcpPublish = async (names) => {
    if (this.closing || this.options.isBusy())
      throw new Error("MCP tools changed while the agent became busy. Retry when the turn finishes.");
    await this.options.beforePublish(names);
  };

  reload(): Promise<void> {
    return this.mutate(async () => {
      // Configuration/discovery failures are retained by the client, never notices.
      await this.options.client.reload(await this.options.store.read(), this.publish);
    });
  }

  setEnabled(name: string, enabled: boolean): Promise<void> {
    return this.mutate(async () => {
      const snapshot = await this.options.store.setDisabled(name, !enabled, this.options.client.getConnectionKey(name));
      await this.options.client.reload(snapshot, this.publish);
    });
  }

  restart(name: string): Promise<void> {
    return this.mutate(() => this.options.client.restart(name, this.publish));
  }

  async beginLogin(name: string): Promise<McpLogin> {
    this.enter();
    this.loginName = name;
    const release = () => { if (!this.cancelling) { this.applying = false; this.loginName = undefined; } };
    try {
      const login = await this.options.client.beginLogin(name, this.publish);
      const completion = login.completion.finally(release);
      void completion.catch(() => undefined);
      return { ...login, completion, cancel: () => this.cancelLogin(name) };
    } catch (error) { release(); throw error; }
  }

  async cancelLogin(name: string): Promise<void> {
    if (this.loginName !== name) return;
    this.cancelling = true;
    try { await this.options.client.cancelLogin(name); }
    finally { this.cancelling = false; this.applying = false; this.loginName = undefined; }
  }
  logout(name: string): Promise<void> { return this.mutate(() => this.options.client.logout(name, this.publish)); }
  async dispose(): Promise<void> { this.closing = true; await this.options.client.dispose(); }
}
