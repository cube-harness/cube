import { Text, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import type { CubeBootstrap, GatewaySelection, RuntimeNotice } from "@cube/runtime";
import { GatewaySetupComponent } from "../components/gateway-picker.js";
import { MessageList } from "../components/message-list.js";
import { Card } from "../components/card.js";

export class OnBoardScreen {
  private readonly title = new Text("Set up Cube\nChoose how to connect to a model.", 0, 1);
  private readonly messages = new MessageList();
  private active?: Component;
  private mounted = false;

  constructor(private readonly tui: TUI) {}

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.tui.addChild(this.title);
    this.tui.addChild(this.messages);
    this.tui.start();
  }

  stopTerminal(): void {
    if (!this.mounted) return;
    this.mounted = false;
    if (this.active) this.tui.removeChild(this.active);
    this.active = undefined;
    this.tui.removeChild(this.messages);
    this.tui.removeChild(this.title);
    this.tui.setFocus(null);
    this.tui.stop();
  }

  showNotice(notice: RuntimeNotice): void {
    this.mount();
    this.messages.addMessage({ role: "system", content: notice.message,
      status: notice.level === "error" ? "error" : "done" });
    this.tui.requestRender();
  }

  async pickGateway(gateway: CubeBootstrap["gateway"]): Promise<GatewaySelection | null> {
    const choices = await gateway.listChoices();
    return this.show<GatewaySelection | null | Error>((finish) => new GatewaySetupComponent({
      onNotice: (notice) => this.showNotice(notice),
      tui: this.tui,
      gateway,
      request: { choices },
      onSelect: finish,
      onCancel: () => finish(null),
      onError: (error) => finish(error instanceof Error ? error : new Error(String(error))),
    })).then((result) => {
      if (result instanceof Error) throw result;
      return result;
    });
  }

  waitForRetry(): Promise<boolean> {
    const hint = new Text("Enter Retry · Esc Exit", 0, 1);
    return this.show<boolean>((finish) => ({
      render: (width) => hint.render(width),
      invalidate: () => hint.invalidate(),
      handleInput: (data) => {
        if (matchesKey(data, "enter")) finish(true);
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) finish(false);
      },
    }));
  }

  private show<T>(create: (finish: (value: T) => void) => Component): Promise<T> {
    this.mount();
    return new Promise((resolve) => {
      let closed = false;
      const component = new Card(create((value) => {
        if (closed) return;
        closed = true;
        this.tui.removeChild(component);
        this.active = undefined;
        this.tui.setFocus(null);
        // The caller may stop the terminal immediately after this promise resolves.
        this.tui.renderNow();
        resolve(value);
      }));
      this.active = component;
      this.tui.addChild(component);
      this.tui.setFocus(component);
      this.tui.requestRender();
    });
  }
}
