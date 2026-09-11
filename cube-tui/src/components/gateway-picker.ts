import {
  SelectList,
  Text,
  CancellableLoader,
  matchesKey,
  type Component,
  type Focusable,
  type SelectItem,
  type TUI,
} from "@earendil-works/pi-tui";
import type {
  CredentialGatewayId,
  RuntimeNotice,
  CubeRuntime,
  GatewayChoice,
  GatewayId,
  GatewayDraft,
  GatewaySelection,
  GatewaySetupRequest,
  ApiKeyGatewayId,
  LocalGatewayId,
} from "@cube/runtime";
import { API_KEY_PROVIDERS } from "@cube/runtime";
import { ModelPickerComponent } from "./model-picker.js";
import { OAuthLoginComponent } from "./oauth-login.js";
import { SecretInput } from "./secret-input.js";
import { appTheme } from "../themes/app.theme.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";
import { KeyHint } from "./key-hint.js";
import { matchesBinding, formatBinding } from "../keybindings.js";

export type GatewayPickerSelection = { gatewayId: GatewayId; replace: boolean };

export type GatewayPickerOptions = {
  choices: GatewayChoice[];
  initialGroup?: GatewayChoice["group"];
  onRemove?(gatewayId: CredentialGatewayId): void;
  onSelect(selection: GatewayPickerSelection): void;
  onCancel(): void;
};

const groupLabels = {
  api_key: "API Key",
  oauth: "OAuth",
  local: "Local",
};

const providerLabels: Record<string, string> = {
  ...API_KEY_PROVIDERS,
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

export class GatewayPickerComponent implements Component, Focusable {
  focused = true;
  private step: "group" | "provider" | "saved" | "remove" = "group";
  private group?: GatewayChoice["group"];
  private readonly title = new Text(appTheme.ui.text.bold("Select Gateway Strategy"), 0, 0);
  private readonly riskNotice = new Text(
    appTheme.ui.muted(
      "  Risk Notice: This provider uses a subscription/OAuth session not officially licensed. Account may be restricted or banned. Use at your own risk.",
    ),
    0,
    0,
  );
  private list: SelectList;
  private readonly hint = new KeyHint([
    { key: "↑/↓", label: "Navigate" },
    { key: "Enter", label: "Select" },
    { key: "Esc", label: "Back" },
  ]);

  constructor(private readonly options: GatewayPickerOptions) {
    this.list = this.groupList();
    if (options.initialGroup) this.showProviders(options.initialGroup);
  }

  private createList(
    items: SelectItem[],
    onSelect: (item: SelectItem) => void,
    onCancel: () => void,
  ): SelectList {
    const list = new SelectList(
      items,
      Math.min(8, Math.max(3, items.length)),
      createSelectListTheme(),
    );
    list.onSelect = onSelect;
    list.onCancel = onCancel;
    return list;
  }

  private groupList(): SelectList {
    return this.createList(
      [...new Set(this.options.choices.map((choice) => choice.group))].map((group) => ({
        value: group,
        label: groupLabels[group],
      })),
      ({ value }) => this.showProviders(value as GatewayChoice["group"]),
      () => this.options.onCancel(),
    );
  }

  private showProviders(group: GatewayChoice["group"]): void {
    this.step = "provider";
    this.group = group;
    this.title.setText(appTheme.ui.text.bold("Select " + groupLabels[group] + " Provider"));
    const choices = this.options.choices.filter((choice) => choice.group === group);
    this.list = this.createList(
      choices.map((choice) => ({
        value: choice.gatewayId,
        label:
          (providerLabels[choice.provider] ?? choice.provider) +
          (choice.configured ? " (Configured)" : ""),
      })),
      ({ value }) => {
        const choice = choices.find((item) => item.gatewayId === value);
        if (!choice) return;
        if (!choice.configured || choice.group === "oauth") {
          this.options.onSelect({ gatewayId: choice.gatewayId, replace: !choice.configured });
        } else {
          this.showSavedChoice(choice);
        }
      },
      () => this.showGroups(),
    );
  }

  private showSavedChoice(choice: GatewayChoice): void {
    this.step = "saved";
    this.title.setText(
      appTheme.ui.text.bold("Configure " + (providerLabels[choice.provider] ?? choice.provider)),
    );
    this.list = this.createList(
      [
        { value: "saved", label: "Use saved configuration" },
        { value: "replace", label: "Configure another" },
      ],
      ({ value }) =>
        this.options.onSelect({
          gatewayId: choice.gatewayId,
          replace: value === "replace",
        }),
      () => this.showProviders(choice.group),
    );
  }

  private showGroups(): void {
    this.step = "group";
    this.group = undefined;
    this.title.setText(appTheme.ui.text.bold("Select Gateway Strategy"));
    this.list = this.groupList();
  }

  render(width: number): string[] {
    const selected = this.options.choices.find(
      (choice) => choice.gatewayId === this.list.getSelectedItem()?.value,
    );
    this.hint.setHints([
      {
        key: formatBinding("tui.select.up") + "/" + formatBinding("tui.select.down"),
        label: "Navigate",
      },
      { key: formatBinding("tui.select.confirm"), label: "Select" },
      { key: formatBinding("tui.select.cancel"), label: "Back" },
      ...(this.step === "provider" &&
      selected?.configured &&
      selected.group !== "local" &&
      this.options.onRemove
        ? [
            {
              key: formatBinding("cube.gateway.removeCredential"),
              label: selected.group === "oauth" ? "Logout" : "Remove API key",
            },
          ]
        : []),
    ]);
    return [
      ...this.title.render(width),
      ...(this.group && this.step === "saved" ? [appTheme.ui.muted(groupLabels[this.group])] : []),
      "",
      ...this.list.render(width),
      ...(this.step === "provider" && (selected?.gatewayId === "oauth/anthropic" || selected?.gatewayId === "oauth/google")
        ? this.riskNotice.render(width)
        : []),
      "",
      ...this.hint.render(width),
    ];
  }

  handleInput(data: string): void {
    if (this.step === "provider" && matchesBinding(data, "cube.gateway.removeCredential")) {
      const choice = this.options.choices.find(
        (item) => item.gatewayId === this.list.getSelectedItem()?.value,
      );
      if (choice?.configured && choice.group !== "local" && this.options.onRemove) {
        this.step = "remove";
        const action = choice.group === "oauth" ? "Logout" : "Remove API key";
        this.title.setText(
          appTheme.ui.text.bold(
            `${action}: ${providerLabels[choice.provider] ?? choice.provider}?`,
          ),
        );
        this.list = this.createList(
          [
            { value: "cancel", label: "Cancel" },
            { value: "remove", label: action },
          ],
          ({ value }) => {
            if (value === "remove") this.options.onRemove!(choice.gatewayId as CredentialGatewayId);
            else this.showProviders(choice.group);
          },
          () => this.showProviders(choice.group),
        );
      }
      return;
    }
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.title.invalidate();
    this.list.invalidate();
    this.hint.invalidate();
  }
}

export type GatewaySetupOptions = {
  tui: TUI;
  gateway: Pick<
    CubeRuntime["gateway"],
    | "createStoredDraft"
    | "createApiKeyDraft"
    | "createLocalDraft"
    | "beginOpenAILogin"
    | "beginGrokLogin"
    | "beginAnthropicLogin"
    | "beginGoogleLogin"
    | "discardDraft"
    | "removeCredential"
    | "listChoices"
  >;
  request: GatewaySetupRequest;
  onNotice(notice: RuntimeNotice): void;
  onSelect(selection: GatewaySelection): void;
  onCancel(): void;
  onError(error: unknown): void;
};

// The same picker is mounted by onboarding and by /gateway inside chat.
export class GatewaySetupComponent implements Component, Focusable {
  private child: Component;
  private hasFocus = false;
  private done = false;
  private draft?: GatewayDraft;
  private readonly abort = new AbortController();
  private loader?: CancellableLoader;
  private loginProvider?: string;

  constructor(private readonly options: GatewaySetupOptions) {
    this.child = this.picker(options.request.choices);
  }

  private picker(
    choices: GatewayChoice[],
    initialGroup?: GatewayChoice["group"],
  ): GatewayPickerComponent {
    return new GatewayPickerComponent({
      choices,
      initialGroup,
      onSelect: (selection) => void this.choose(selection).catch((error) => this.fail(error)),
      onCancel: () => this.cancel(),
      onRemove: (gatewayId) => void this.remove(gatewayId).catch((error) => this.fail(error)),
    });
  }

  private async remove(gatewayId: CredentialGatewayId): Promise<void> {
    this.setChild(new Text("Removing credential…", 0, 0));
    const result = await this.options.gateway.removeCredential(gatewayId);
    if (result.active) this.options.request.current = undefined;
    this.options.onNotice({
      level: "info",
      message:
        (gatewayId.startsWith("oauth/") ? "Logged out." : "API key removed.") +
        (result.cacheCleared
          ? ""
          : " Credential removed, but catalog cleanup failed; retry /gateway."),
    });
    this.setChild(
      this.picker(
        await this.options.gateway.listChoices(),
        gatewayId.startsWith("oauth/") ? "oauth" : "api_key",
      ),
    );
  }

  get focused(): boolean {
    return this.hasFocus;
  }
  set focused(value: boolean) {
    this.hasFocus = value;
    if ("focused" in this.child) (this.child as Component & Focusable).focused = value;
  }

  private setChild(child: Component): void {
    if (this.done) return;
    if ("focused" in this.child) (this.child as Component & Focusable).focused = false;
    this.child = child;
    this.focused = this.hasFocus;
    this.options.tui.requestRender();
  }

  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.abort.abort();
    this.loader?.dispose();
    if (this.draft) this.options.gateway.discardDraft(this.draft.draftId);
    this.options.onNotice({
      level: "info",
      message:
        (this.loginProvider
          ? `${this.loginProvider} sign-in cancelled.`
          : "Gateway setup cancelled.") + " Saved configuration unchanged.",
    });
    this.options.onCancel();
  }

  private fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.abort.abort();
    this.loader?.dispose();
    if (this.draft) this.options.gateway.discardDraft(this.draft.draftId);
    this.options.onError(error);
  }

  private async load(load: (signal: AbortSignal) => Promise<GatewayDraft>): Promise<void> {
    const loader = new CancellableLoader(
      this.options.tui,
      appTheme.ui.primary,
      appTheme.ui.muted,
      "Checking gateway…",
    );
    this.loader = loader;
    loader.onAbort = () => this.cancel();
    this.setChild(loader);
    loader.start();
    try {
      const draft = await load(this.abort.signal);
      if (this.done) {
        this.options.gateway.discardDraft(draft.draftId);
        return;
      }
      this.showModels(draft);
    } finally {
      loader.dispose();
      this.loader = undefined;
    }
  }

  private async choose(selection: GatewayPickerSelection): Promise<void> {
    const gateway = this.options.gateway;
    if (!selection.replace) {
      await this.load((signal) => gateway.createStoredDraft(selection.gatewayId, signal));
    } else if (selection.gatewayId.startsWith("api_key/")) {
      this.setChild(
        new SecretInput({
          title: `${providerLabels[selection.gatewayId.split("/")[1]!] ?? selection.gatewayId} API key`,
          onCancel: () => this.cancel(),
          onSubmit: (key) => {
            void this.load((signal) =>
              gateway.createApiKeyDraft(selection.gatewayId as ApiKeyGatewayId, key, signal),
            ).catch((error) => this.fail(error));
          },
        }),
      );
    } else if (selection.gatewayId.startsWith("local/")) {
      const ollama = selection.gatewayId === "local/ollama";
      this.setChild(
        new SecretInput({
          title: ollama ? "Ollama endpoint" : "LM Studio endpoint",
          masked: false,
          initialValue: ollama ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234/v1",
          onCancel: () => this.cancel(),
          onSubmit: (url) => {
            void this.load((signal) =>
              gateway.createLocalDraft(selection.gatewayId as LocalGatewayId, url, signal),
            ).catch((error) => this.fail(error));
          },
        }),
      );
    } else {
      const grok = selection.gatewayId === "oauth/xai";
      const providerName =
        providerLabels[selection.gatewayId.split("/")[1]!] ?? selection.gatewayId;
      this.loginProvider = providerName;
      const waiting = new Text(`Opening ${providerName} sign-in…`, 0, 0);
      this.setChild({
        render: (width) => waiting.render(width),
        invalidate: () => waiting.invalidate(),
        handleInput: (data) => {
          if (matchesKey(data, "escape")) this.cancel();
        },
      });
      const login = await (grok
        ? gateway.beginGrokLogin(this.abort.signal)
        : selection.gatewayId === "oauth/anthropic"
          ? gateway.beginAnthropicLogin(this.abort.signal)
          : selection.gatewayId === "oauth/google"
            ? gateway.beginGoogleLogin(this.abort.signal)
          : gateway.beginOpenAILogin(this.abort.signal));
      if (this.done) {
        void login.completion.catch(() => undefined);
        await login.cancel();
        return;
      }
      this.setChild(
        new OAuthLoginComponent({
          tui: this.options.tui,
          providerName,
          ...login,
          onComplete: (draft: GatewayDraft) => {
            if (this.done) {
              gateway.discardDraft(draft.draftId);
              return;
            }
            this.loginProvider = undefined;
            try {
              this.showModels(draft);
            } catch (error) {
              this.fail(error);
            }
          },
          onCancel: () => this.cancel(),
          onError: (error) => this.fail(error),
        }),
      );
    }
  }

  private showModels(draft: GatewayDraft): void {
    this.draft = draft;
    const firstModel = Object.values(draft.catalog.providers).flatMap(
      (provider) => provider.models,
    )[0]?.modelId;
    if (!firstModel) throw new Error("No models are available for this gateway.");
    const current = draft.currentModelId
      ? {
          modelId: draft.currentModelId,
          reasoningEffort:
            this.options.request.current?.gatewayId === draft.gatewayId
              ? this.options.request.current.model.reasoningEffort
              : undefined,
        }
      : undefined;
    this.setChild(
      new ModelPickerComponent({
        gatewayId: draft.gatewayId,
        catalog: draft.catalog,
        currentModelId: current?.modelId,
        currentReasoningEffort: current?.reasoningEffort,
        onCancel: () => this.cancel(),
        onSelect: (model) => {
          if (this.done) return;
          this.done = true;
          this.options.onSelect({ draftId: draft.draftId, model });
        },
      }),
    );
  }

  render(width: number): string[] {
    return this.done ? [] : this.child.render(width);
  }
  handleInput(data: string): void {
    if (this.done) return;
    if (matchesKey(data, "ctrl+c")) {
      this.cancel();
      return;
    }
    this.child.handleInput?.(data);
  }
  invalidate(): void {
    this.child.invalidate?.();
  }
}
