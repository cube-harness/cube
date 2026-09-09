import {
  CancellableLoader,
  Text,
  hyperlink,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";

export type OAuthLoginOptions<T> = {
  tui: TUI;
  authorizationUrl: string;
  providerName?: string;
  userCode?: string;
  expiresAt?: number;
  completion: Promise<T>;
  cancel(): Promise<void>;
  onComplete(value: T): void;
  onCancel(): void;
  onError(error: unknown): void;
};

export class OAuthLoginComponent<T> implements Component {
  private readonly loader: CancellableLoader;
  private done = false;

  constructor(private readonly options: OAuthLoginOptions<T>) {
    this.loader = new CancellableLoader(
      options.tui,
      appTheme.ui.primary,
      appTheme.ui.muted,
      `Waiting for ${options.providerName ?? "OpenAI"} sign-in… (esc to cancel)`,
    );
    this.loader.onAbort = () => {
      if (this.done) return;
      this.done = true;
      this.loader.dispose();
      void options.cancel().catch(() => undefined);
      options.onCancel();
    };
    this.loader.start();
    void options.completion.then(
      (value) => {
        if (this.done) return;
        this.done = true;
        this.loader.dispose();
        options.onComplete(value);
      },
      (error) => {
        if (this.done) return;
        this.done = true;
        this.loader.dispose();
        options.onError(error);
      },
    );
  }

  render(width: number): string[] {
    if (this.done) return [];
    const link = new Text(
      hyperlink(appTheme.markdown.link(this.options.authorizationUrl), this.options.authorizationUrl),
      0,
      0,
    );
    return [
      ...new Text(appTheme.ui.text.bold(`Sign in to ${this.options.providerName ?? "OpenAI"}`), 0, 0).render(width),
      ...new Text("Open this link in your browser:", 0, 0).render(width),
      "",
      ...link.render(width),
      ...(this.options.userCode ? new Text(`Confirmation code: ${this.options.userCode}`, 0, 0).render(width) : []),
      "",
      ...(this.options.expiresAt === undefined ? [] : new Text(
        `Expires in ${Math.floor(Math.max(0, Math.ceil((this.options.expiresAt - Date.now()) / 1000)) / 60)}:${String(Math.max(0, Math.ceil((this.options.expiresAt - Date.now()) / 1000)) % 60).padStart(2, "0")}`,
        0, 0,
      ).render(width)),
      ...this.loader.render(width).map((line) => truncateToWidth(line, width)),
    ];
  }

  handleInput(data: string): void {
    this.loader.handleInput(data);
  }

  invalidate(): void {
    this.loader.invalidate();
  }
}
