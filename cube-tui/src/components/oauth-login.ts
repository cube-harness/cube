import {
  CancellableLoader,
  Text,
  hyperlink,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";

export type OAuthLoginOptions<T> = {
  tui: TUI;
  authorizationUrl: string;
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
      "Waiting for OpenAI sign-in…",
    );
    this.loader.onAbort = () => {
      if (this.done) return;
      this.done = true;
      this.loader.dispose();
      void options.cancel().then(options.onCancel, options.onCancel);
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
    const link = new Text(
      hyperlink(this.options.authorizationUrl, this.options.authorizationUrl),
      0,
      0,
    );
    return [
      ...new Text(appTheme.ui.text.bold("Sign in to OpenAI"), 0, 0).render(width),
      ...new Text("Open this link in your browser:", 0, 0).render(width),
      ...link.render(width),
      "",
      ...this.loader.render(width),
      appTheme.ui.muted("Esc Cancel"),
    ];
  }

  handleInput(data: string): void {
    this.loader.handleInput(data);
  }

  invalidate(): void {
    this.loader.invalidate();
  }
}
