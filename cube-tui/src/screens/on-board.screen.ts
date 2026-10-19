import {
  CancellableLoader,
  Container,
  SelectList,
  Spacer,
  Text,
  matchesKey,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { CubeBootstrap, CubeUpdate, GatewaySelection, RuntimeNotice } from "@cube/runtime";
import { GatewaySetupComponent } from "../components/gateway-picker.js";
import { MessageList } from "../components/message-list.js";
import { Card } from "../components/card.js";
import { KeyHint } from "../components/key-hint.js";
import { PetPanel } from "../components/pet.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";
import { appTheme } from "../themes/app.theme.js";

export class OnBoardScreen {
  private readonly setupTitle = `Set up ${appTheme.ui.primary("Cube CLI")}\nChoose how to connect to a model.`;
  private readonly title = new Text(this.setupTitle, 2, 0);
  private readonly pet: PetPanel;
  private readonly messages = new MessageList();
  private active?: Component;
  private mounted = false;

  constructor(private readonly tui: TUI, petCacheDir?: string) {
    this.pet = new PetPanel(tui, petCacheDir, () => "", () => 0, { header: true, size: 80 });
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.tui.addChild(this.pet);
    this.tui.addChild(this.title);
    this.tui.addChild(this.messages);
    this.tui.start();
    void this.pet.start();
  }

  stopTerminal(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.pet.stop();
    if (this.active) this.tui.removeChild(this.active);
    this.active = undefined;
    this.tui.removeChild(this.messages);
    this.tui.removeChild(this.title);
    this.tui.removeChild(this.pet);
    this.tui.setFocus(null);
    this.tui.stop();
  }

  showNotice(notice: RuntimeNotice): void {
    this.mount();
    this.messages.addMessage({
      role: "system",
      content: notice.message,
      status: notice.level === "error" ? "error" : "done",
    });
    this.tui.requestRender();
  }

  async pickTrust(workspaceRoot: string): Promise<boolean | null> {
    this.title.setText(`Welcome to the ${appTheme.ui.primary("Cube CLI")}`);
    try {
      return await this.show<boolean | null>((finish) => {
        const content = new Container();
        content.addChild(new Text(`${appTheme.ui.tertiary("Accessing workspace:")} ${workspaceRoot}`,0,0))
        content.addChild(
          new Text(
            `${appTheme.ui.primary("Cube CLI")} requires permission to read, edit, and excute file here.\nCommands run on your computer, not in an OS sandbox. Trust does not skip tool approval.`,
            0,
            1,
          ),
        );
        const choices = new SelectList(
          [
            { value: "trust", label: "Yes, I trust", description: "Save this choice and continue" },
            {
              value: "reject",
              label: "No, exit",
              description: "Exit Cube without saving",
            },
          ],
          2,
          createSelectListTheme(),
        );
        choices.onSelect = (item) => finish(item.value === "trust");
        choices.onCancel = () => finish(null);
        content.addChild(choices);
        content.addChild(new Spacer)
        content.addChild(
          new KeyHint([
            { key: "↑/↓", label: "Navigate" },
            { key: "Enter", label: "Select" },
            { key: "Esc/ctrl+c", label: "Exit" },
          ]),
        );
        return Object.assign(content, {
          handleInput: (data: string) => {
            if (matchesKey(data, "ctrl+c")) finish(null);
            else choices.handleInput(data);
          },
        });
      });
    } finally {
      this.title.setText(this.setupTitle);
    }
  }

  async pickUpdate(update: CubeUpdate): Promise<"update" | "continue" | null> {
    this.title.setText(`A new version of ${appTheme.ui.primary("Cube CLI")} is available`);
    try {
      return await this.show<"update" | "continue" | null>((finish) => {
        const content = new Container();
        content.addChild(new Text(
          `${appTheme.ui.muted("Version:")} ${appTheme.status.warning(update.currentVersion)} ${appTheme.ui.muted("⭢")} ${appTheme.status.success(update.version)}`,
          0,
          0,
        ));
        content.addChild(new Spacer(1));
        const choices = new SelectList(
          [
            {
              value: "update",
              label: "Update",
              description: "Install the latest version and restart Cube",
            },
            { value: "continue", label: "Skip", description: "Use the current version" },
            { value: "cancel", label: "Cancel", description: "Exit Cube" },
          ],
          3,
          createSelectListTheme(),
        );
        choices.onSelect = (item) =>
          finish(item.value === "cancel" ? null : (item.value as "update" | "continue"));
        choices.onCancel = () => finish(null);
        content.addChild(choices);
        content.addChild(new Spacer)
        content.addChild(
          new KeyHint([
            { key: "↑/↓", label: "Navigate" },
            { key: "Enter", label: "Select" },
            { key: "Esc/ctrl+c", label: "Exit" },
          ]),
        );
        return Object.assign(content, {
          handleInput: (data: string) => {
            if (matchesKey(data, "ctrl+c")) finish(null);
            else choices.handleInput(data);
          },
        });
      });
    } finally {
      this.title.setText(this.setupTitle);
    }
  }

  async downloadUpdate(work: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    this.title.setText("Update Cube");
    const result = await this.show<boolean | Error>((finish) => {
      const loader = new CancellableLoader(
        this.tui,
        appTheme.ui.primary,
        appTheme.ui.muted,
        "Downloading Cube update…",
      );
      const handleInput = loader.handleInput.bind(loader);
      loader.handleInput = (data) => handleInput(matchesKey(data, "ctrl+c") ? "\x1b" : data);
      void work(loader.signal).then(
        () => {
          loader.stop();
          finish(true);
        },
        (error: unknown) => {
          loader.stop();
          finish(
            loader.aborted ? false : error instanceof Error ? error : new Error(String(error)),
          );
        },
      );
      return loader;
    });
    if (result instanceof Error) throw result;
    return result;
  }

  async pickGateway(gateway: CubeBootstrap["gateway"]): Promise<GatewaySelection | null> {
    const choices = await gateway.listChoices();
    return this.show<GatewaySelection | null | Error>(
      (finish) =>
        new GatewaySetupComponent({
          onNotice: (notice) => this.showNotice(notice),
          tui: this.tui,
          gateway,
          request: { choices },
          onSelect: finish,
          onCancel: () => finish(null),
          onError: (error) => finish(error instanceof Error ? error : new Error(String(error))),
        }),
    ).then((result) => {
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
      const component = new Card(
        create((value) => {
          if (closed) return;
          closed = true;
          this.tui.removeChild(component);
          this.active = undefined;
          this.tui.setFocus(null);
          // The caller may stop the terminal immediately after this promise resolves.
          this.tui.renderNow();
          resolve(value);
        }),
      );
      this.active = component;
      this.tui.addChild(component);
      this.tui.setFocus(component);
      this.tui.requestRender();
    });
  }
}
