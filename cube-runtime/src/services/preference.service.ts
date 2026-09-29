import { ConfigStore, type HomeManager } from "@cube/workspace";
import type { PreferenceState } from "../types.js";
import { skillPathIdentity, type CubeSkills, type SkillChoice } from "@cube/agent";

const copyState = (state: PreferenceState): PreferenceState => ({
  theme: state.theme,
  appTitle: [...state.appTitle],
  statusLine: [...state.statusLine],
});

export class PreferenceService {
  private state: PreferenceState;
  private skillWrite: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly home: HomeManager,
    state: PreferenceState,
    private readonly skills?: CubeSkills,
  ) {
    this.state = copyState(state);
  }

  get(): PreferenceState {
    return copyState(this.state);
  }

  async listSkills(): Promise<SkillChoice[]> {
    return this.skills?.list() ?? [];
  }

  setSkillEnabled(path: string, enabled: boolean): Promise<SkillChoice[]> {
    const write = this.skillWrite.then(async () => {
      const choice = (await this.listSkills()).find((skill) => skill.path === path);
      if (!choice || !this.skills) throw new Error("Skill is no longer available. Reopen /skills.");
      const saved = await ConfigStore(this.home).update((config) => ({ ...config,
        skills: { disabled: enabled
          ? config.skills.disabled.filter((item) => skillPathIdentity(item) !== path)
          : [...new Set([...config.skills.disabled, path])],
        },
      }));
      this.skills.setDisabled(saved.skills.disabled);
      return this.listSkills();
    });
    this.skillWrite = write.catch(() => undefined);
    return write;
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
