import { access, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getBuiltinSkillsPath, type HomeManager, type WorkspaceManager } from "@cube/workspace";
import type { IMastraLogger } from "@mastra/core/logger";
import { RequestContext } from "@mastra/core/request-context";
import { mergeWorkspaceSkills, resolveAgentSkills, type WorkspaceSkills } from "@mastra/core/skills";

export type SkillChoice = {
  name: string;
  path: string;
  configKey: string;
  description: string;
  source: "project" | "global" | "builtin";
  enabled: boolean;
  userInvocable: boolean;
};
export type SkillSnapshot = {
  catalog: readonly SkillChoice[];
  projectPaths: string[];
  agentPaths: string[];
  enabled: WorkspaceSkills;
};
export type CubeSkills = {
  list(): Promise<SkillChoice[]>;
  setDisabled(paths: readonly string[]): void;
  snapshot(context: RequestContext): Promise<SkillSnapshot>;
};

export const skillPathIdentity = (path: string): string => {
  if (path.startsWith("builtin:")) return path;
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
};

async function createSkillSnapshot(catalog: SkillChoice[]): Promise<SkillSnapshot> {
  const projectPaths = catalog.filter(s => s.enabled && s.source === "project").map(s => s.path);
  const userNames = new Set(catalog.filter(s => s.enabled && s.source !== "builtin").map(s => s.name));
  const agentPaths = catalog.filter(s => s.enabled && (s.source === "global" ||
    (s.source === "builtin" && !userNames.has(s.name)))).map(s => s.path);
  const { merged } = await mergeWorkspaceSkills(resolveAgentSkills(agentPaths), resolveAgentSkills(projectPaths));
  return { catalog, projectPaths, agentPaths, enabled: merged };
}

export function restrictCubeSkills(skills: CubeSkills, names?: readonly string[]): CubeSkills {
  if (!names) return skills;
  const allowed = new Set(names);
  const list = async () => (await skills.list()).filter(skill => allowed.has(skill.name));
  const snapshots = new WeakMap<RequestContext, Promise<SkillSnapshot>>();
  return {
    ...skills,
    list,
    snapshot(context) {
      let pending = snapshots.get(context);
      if (!pending) {
        pending = list().then(createSkillSnapshot);
        snapshots.set(context, pending);
        void pending.catch(() => snapshots.delete(context));
      }
      return pending;
    },
  };
}

export async function createCubeSkills(
  home: HomeManager, workspace: WorkspaceManager, disabled: readonly string[],
  options: { builtinPath?: string; logger?: Pick<IMastraLogger, "warn"> } = {},
): Promise<CubeSkills> {
  const project = resolveAgentSkills((await workspace.getPaths()).skillsDirs);
  const global = resolveAgentSkills([home.getSkillDir(), join(home.getUserHome(), ".agents", "skills")]);
  const builtinPath = options.builtinPath ?? await getBuiltinSkillsPath();
  await access(builtinPath).catch(() => options.logger?.warn("Built-in skills directory unavailable", {
    path: builtinPath,
  }));
  const builtin = resolveAgentSkills([builtinPath]);
  let disabledPaths = [...disabled];
  const snapshots = new WeakMap<RequestContext, Promise<SkillSnapshot>>();
  const canonical = async (path: string) => resolve(await realpath(path).catch(() => path));
  async function list(): Promise<SkillChoice[]> {
    const disabledAtStart = [...disabledPaths];
    // Preserve native refresh/cooldown behavior; the picker includes shadowed sources.
    await Promise.all([project.maybeRefresh(), global.maybeRefresh(), builtin.maybeRefresh()]);
    const disabledSet = new Set((await Promise.all(disabledAtStart.map(item =>
      item.startsWith("builtin:") ? item : canonical(item)))).map(skillPathIdentity));
    const seen = new Set<string>();
    const choices: SkillChoice[] = [];
    for (const [source, registry] of [["global", global], ["project", project], ["builtin", builtin]] as const) {
      for (const skill of await registry.list()) {
        const path = await canonical(join(skill.path, "SKILL.md"));
        const identity = skillPathIdentity(path);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const configKey = source === "builtin" ? `builtin:${skill.name}` : path;
        choices.push({ name: skill.name, path, configKey, source, description: skill.description,
          enabled: !disabledSet.has(skillPathIdentity(configKey)), userInvocable: skill["user-invocable"] !== false });
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
        pending = list().then(createSkillSnapshot);
        snapshots.set(context, pending);
        void pending.catch(() => snapshots.delete(context));
      }
      return pending;
    },
  };
}
