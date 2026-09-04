import { ConfigStore, type HomeManager } from "@cube/workspace";
import type { PreferenceState } from "../types.js";

const copyState = (state: PreferenceState): PreferenceState => ({
  theme: state.theme,
  appTitle: [...state.appTitle],
  statusLine: [...state.statusLine],
});

export class PreferenceService {
  private state: PreferenceState;

  constructor(
    private readonly home: HomeManager,
    state: PreferenceState,
  ) {
    this.state = copyState(state);
  }

  get(): PreferenceState {
    return copyState(this.state);
  }

  async setTheme(theme: string): Promise<PreferenceState> {
    await ConfigStore(this.home).update((config) => ({ ...config, theme }));
    this.state = { ...this.state, theme };
    return this.get();
  }

  async setTitle(appTitle: string[]): Promise<PreferenceState> {
    const next = [...appTitle];
    await ConfigStore(this.home).update((config) => ({
      ...config,
      app_title: next,
    }));
    this.state = { ...this.state, appTitle: next };
    return this.get();
  }

  async setStatusLine(statusLine: string[]): Promise<PreferenceState> {
    const next = [...statusLine];
    await ConfigStore(this.home).update((config) => ({
      ...config,
      status_line: next,
    }));
    this.state = { ...this.state, statusLine: next };
    return this.get();
  }
}
