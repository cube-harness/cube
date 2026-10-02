import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { HomeManager, WorkspaceManager } from "@cube/workspace";
import { RequestContext } from "@mastra/core/request-context";
import { mergeWorkspaceSkills, resolveAgentSkills, type WorkspaceSkills } from "@mastra/core/skills";

export type SkillChoice = {
  name: string;
  path: string;
  description: string;
  source: "project" | "global";
  enabled: boolean;
  userInvocable: boolean;
};
export type SkillSnapshot = {
  catalog: readonly SkillChoice[];
  projectPaths: string[];
  globalPaths: string[];
  enabled: WorkspaceSkills;
};
export type CubeSkills = {
  list(): Promise<SkillChoice[]>;
  setDisabled(paths: readonly string[]): void;
  snapshot(context: RequestContext): Promise<SkillSnapshot>;
};

export const skillPathIdentity = (path: string): string => {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
};

export async function createCubeSkills(
  home: HomeManager, workspace: WorkspaceManager, disabled: readonly string[],
): Promise<CubeSkills> {
  const project = resolveAgentSkills((await workspace.getPaths()).skillsDirs);
  const global = resolveAgentSkills([home.getSkillDir(), join(home.getUserHome(), ".agents", "skills")]);
  let disabledPaths = [...disabled];
  const snapshots = new WeakMap<RequestContext, Promise<SkillSnapshot>>();
  const canonical = async (path: string) => resolve(await realpath(path).catch(() => path));
  async function list(): Promise<SkillChoice[]> {
    const disabledAtStart = [...disabledPaths];
    // Preserve native refresh/cooldown behavior; the picker includes shadowed sources.
    await Promise.all([project.maybeRefresh(), global.maybeRefresh()]);
    const disabledSet = new Set((await Promise.all(disabledAtStart.map(canonical))).map(skillPathIdentity));
    const seen = new Set<string>();
    const choices: SkillChoice[] = [];
    for (const [source, registry] of [["global", global], ["project", project]] as const) {
      for (const skill of await registry.list()) {
        const path = await canonical(join(skill.path, "SKILL.md"));
        const identity = skillPathIdentity(path);
        if (seen.has(identity)) continue;
        seen.add(identity);
        choices.push({ name: skill.name, path, source, description: skill.description,
          enabled: !disabledSet.has(identity), userInvocable: skill["user-invocable"] !== false });
      }
    }
    return choices.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source) || a.path.localeCompare(b.path));
  }
  return {
    list,
    setDisabled(paths) { disabledPaths = [...paths]; },
    snapshot(context) {
      let pending = snapshots.get(context);
      if (!pending) {
        pending = (async () => {
          const catalog = await list();
          const projectPaths = catalog.filter((s) => s.enabled && s.source === "project").map((s) => s.path);
          const globalPaths = catalog.filter((s) => s.enabled && s.source === "global").map((s) => s.path);
          const { merged } = await mergeWorkspaceSkills(resolveAgentSkills(globalPaths), resolveAgentSkills(projectPaths));
          return { catalog, projectPaths, globalPaths, enabled: merged };
        })();
        snapshots.set(context, pending);
        void pending.catch(() => snapshots.delete(context));
      }
      return pending;
    },
  };
}
