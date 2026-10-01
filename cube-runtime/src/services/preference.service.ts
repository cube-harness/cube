import { ConfigStore, type HomeManager } from "@cube/workspace";
import type { PreferenceState } from "../types.js";
import { skillPathIdentity, type CubeSkills, type SkillChoice } from "@cube/agent";
import { realpath } from "node:fs/promises";

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

  setSkillsEnabled(changes: readonly Pick<SkillChoice, "path" | "enabled">[]): Promise<void> {
    const pending = changes.map((change) => ({ ...change }));
    const write = this.skillWrite.then(async () => {
      if (!pending.length) return;
      const choices = await this.listSkills();
      if (
        !this.skills ||
        pending.some(({ path }) => !choices.some((skill) => skill.path === path))
      ) {
        throw new Error("Skill is no longer available. Reopen /skills.");
      }
      const updates = new Map(
        pending.map(({ path, enabled }) => [skillPathIdentity(path), enabled]),
      );
      const store = ConfigStore(this.home);
      const current = await store.read();
      const aliases = new Set<string>();
      for (const item of current.skills.disabled) {
        if (updates.has(skillPathIdentity(await realpath(item).catch(() => item))))
          aliases.add(item);
      }
      const saved = await store.update((config) => ({
        ...config,
        skills: {
          disabled: [
            ...new Set([
              ...config.skills.disabled.filter(
                (item) => !aliases.has(item) && !updates.has(skillPathIdentity(item)),
              ),
              ...pending.filter(({ enabled }) => !enabled).map(({ path }) => path),
            ]),
          ],
        },
      }));
      this.skills.setDisabled(saved.skills.disabled);
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
