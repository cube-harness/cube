import {
  Key, SelectList, Text, fuzzyFilter, getKeybindings, matchesKey,
  truncateToWidth, visibleWidth, type Component, type Focusable, type TUI,
} from "@earendil-works/pi-tui";
import { openExternalUrl, type McpService, type McpServerState } from "@cube/runtime";
import { stripVTControlCharacters } from "node:util";
import { appTheme } from "../themes/app.theme.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";
import { SearchBar } from "./search-bar.js";
import { KeyHint } from "./key-hint.js";
import { OAuthLoginComponent } from "./oauth-login.js";

const status = (server: McpServerState): string => (
  server.status === "connected" ? appTheme.status.success
    : server.status === "disabled" ? appTheme.ui.muted
      : server.status === "error" ? appTheme.status.error : appTheme.status.warning
)(server.status);

export class McpPicker implements Component, Focusable {
  private readonly search = new SearchBar();
  private list!: SelectList;
  private actions!: SelectList;
  private tools!: SelectList;
  private viewingTools = false;
  private width = 80;
  private selected?: string;
  private error?: string;
  private busy = false;
  private disposed = false;
  private loginName?: string;
  private login?: OAuthLoginComponent<void>;
  private readonly unsubscribe: () => void;

  get focused(): boolean { return this.search.focused; }
  set focused(value: boolean) { this.search.focused = value; }

  constructor(private readonly service: McpService, private readonly options: {
    tui: TUI; onClose(): void; onChange(): void;
  }) {
    this.rebuild();
    this.unsubscribe = service.subscribe(() => {
      if (this.disposed) return;
      this.rebuild();
      this.options.onChange();
    });
  }

  private rebuild(): void {
    const state = this.service.get();
    const selected = this.list?.getSelectedItem()?.value;
    const visible = fuzzyFilter(state.servers, this.search.getQuery(), server => `${server.name} ${server.status}`);
    this.list = new SelectList(visible.map(server => {
      const right = status(server);
      const available = Math.max(1, this.width - 4 - visibleWidth(right) - 2);
      const left = truncateToWidth(`${server.name} · ${server.tools.length} tools`, available);
      return { value: server.name, label: `${left}${" ".repeat(Math.max(0, available - visibleWidth(left)) + 2)}${right}` };
    }), 10, {
      ...createSelectListTheme(),
      noMatch: () => appTheme.ui.muted(state.servers.length ? "No matching servers." : "No MCP servers. Add mcpServers to ~/.cube/mcp.json, then /reload."),
    });
    this.list.setSelectedIndex(Math.max(0, visible.findIndex(server => server.name === selected)));
    this.list.onSelect = item => { this.selected = item.value; this.error = undefined; this.rebuild(); };
    this.list.onCancel = this.options.onClose;
    const server = state.servers.find(server => server.name === this.selected);
    if (this.selected && !server) { this.selected = undefined; this.viewingTools = false; }
    const items = server && (server.command || server.endpoint) ? [
      ...(server.tools.length ? [{ value: "tools", label: `Tools (${server.tools.length})` }] : []),
      { value: "toggle", label: server.status === "disabled" ? "Enable" : "Disable" },
      ...(server.status !== "disabled" && (server.command || server.endpoint) ? [{ value: "restart", label: "Restart" }] : []),
      ...(server.oauth && server.status !== "disabled" && server.status !== "connected" ? [{ value: "login", label: "Login" }] : []),
      ...(server.canLogout ? [{ value: "logout", label: "Logout" }] : []),
    ] : [];
    const action = this.actions?.getSelectedItem()?.value;
    this.actions = new SelectList(items, 5, createSelectListTheme());
    this.actions.setSelectedIndex(Math.max(0, items.findIndex(item => item.value === action)));
    this.actions.onSelect = item => { void this.apply(item.value); };
    const selectedTool = this.tools?.getSelectedItem()?.value;
    this.tools = new SelectList((server?.tools ?? []).map(tool => ({ value: tool.name,
      label: tool.name, description: tool.description.replace(/\s+/g, " ").trim(),
    })), 10, createSelectListTheme());
    this.tools.setSelectedIndex(Math.max(0, server?.tools.findIndex(tool => tool.name === selectedTool) ?? 0));
  }

  private async apply(action: string): Promise<void> {
    const name = this.selected;
    if (!name || this.busy) return;
    if (action === "tools") { this.viewingTools = true; this.options.onChange(); return; }
    this.busy = true;
    this.error = undefined;
    this.options.onChange();
    try {
      if (action === "login") {
        this.loginName = name;
        const login = await this.service.beginLogin(name);
        if (this.disposed || this.loginName !== name) { await login.cancel(); return; }
        const finish = (error?: unknown) => {
          this.login = undefined;
          this.loginName = undefined;
          this.busy = false;
          if (error) this.showError(error);
          this.rebuild();
          this.options.onChange();
        };
        this.login = new OAuthLoginComponent({
          tui: this.options.tui, providerName: name, ...login,
          onComplete: () => finish(), onCancel: () => finish(), onError: finish,
        });
        // The clickable URL remains available even when the browser cannot open.
        void openExternalUrl(login.authorizationUrl).catch(() => undefined);
        return;
      }
      if (action === "toggle") {
        const server = this.service.get().servers.find(server => server.name === name);
        await this.service.setEnabled(name, server?.status === "disabled");
      } else if (action === "restart") await this.service.restart(name);
      else if (action === "logout") await this.service.logout(name);
    } catch (error) {
      if (!this.disposed && (action !== "login" || this.loginName === name)) this.showError(error);
      this.loginName = undefined;
    } finally {
      if (!this.login && !this.disposed) {
        this.busy = false;
        this.rebuild();
        this.options.onChange();
      }
    }
  }

  private showError(error: unknown): void {
    this.error = stripVTControlCharacters(error instanceof Error ? error.message : String(error)).slice(0, 2000);
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) {
      if (this.loginName) {
        const name = this.loginName;
        this.login?.dispose();
        this.login = undefined;
        this.loginName = undefined;
        void this.service.cancelLogin(name).catch(error => { if (!this.disposed) this.showError(error); })
          .finally(() => { if (!this.disposed) { this.busy = false; this.rebuild(); this.options.onChange(); } });
      } else if (this.viewingTools) this.viewingTools = false;
      else if (this.busy) this.options.onClose();
      else if (this.selected) { this.selected = undefined; this.error = undefined; }
      else this.options.onClose();
    } else if (this.login) this.login.handleInput(data);
    else if (!this.busy) {
      if (this.viewingTools) this.tools.handleInput(data);
      else if (this.selected) this.actions.handleInput(data);
      else if ((["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm"] as const)
        .some(binding => keys.matches(data, binding))) this.list.handleInput(data);
      else { this.search.handleInput(data); this.rebuild(); }
    }
    this.options.onChange();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.login?.dispose();
    if (this.loginName) void this.service.cancelLogin(this.loginName).catch(() => undefined);
  }

  invalidate(): void { this.list.invalidate(); this.actions.invalidate(); this.tools.invalidate(); this.search.invalidate(); this.login?.invalidate(); }

  render(width: number): string[] {
    if (this.width !== width) { this.width = width; this.rebuild(); }
    if (this.login) return this.login.render(width);
    const state = this.service.get();
    const server = state.servers.find(server => server.name === this.selected);
    const error = this.error ?? server?.error ?? state.error;
    const lines = server ? [
      ...new Text(`${appTheme.ui.text.bold(server.name)} · ${status(server)}`, 0, 0).render(width),
      ...new Text(`${server.transport}: ${server.endpoint ?? server.command ?? "Invalid configuration"}`, 0, 0).render(width),
      "",
      ...(this.viewingTools ? this.tools.render(width) : this.busy
        ? [appTheme.ui.muted(this.loginName ? "Preparing sign-in…" : "Applying…")] : this.actions.render(width)),
    ] : [
      ...new Text(appTheme.ui.text.bold("MCP Servers"), 0, 0).render(width),
      ...this.search.render(width), "", ...this.list.render(width),
    ];
    return [...lines,
      ...(error ? ["", ...new Text(appTheme.status.error(error), 0, 0).render(width)] : []), "",
      ...new KeyHint([
        { key: "↑/↓", label: "Navigate" },
        ...(this.viewingTools ? [] : [{ key: "Enter", label: server ? "Apply" : "Details" }]),
        { key: "Esc", label: this.loginName ? "Cancel sign-in" : server ? "Back" : "Close" },
      ]).render(width),
    ];
  }
}
