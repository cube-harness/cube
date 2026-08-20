// workspace-manager.ts
import path from "node:path";
import { access } from "node:fs/promises";
import { WorkspaceRegistryStore } from "./store/store.js";
import type { Home } from "./home.js";

const AGENT_FILE_CANDIDATES = [
  ".agents/AGENTS.md",
  ".cube/AGENTS.md",
  ".codex/AGENTS.md",
  ".claude/AGENTS.md",
  "AGENTS.md",
  "CLAUDE.md",
];
const SKILLS_DIR_CANDIDATES = [".agents/skills",".cube/skills", ".codex/skills", ".claude/skills"];

export interface WorkspacePaths {
  root: string;
  cubeDir: string;
  skillsDirs: string[];
  agentFilePaths: string[];
}

export class WorkspaceManager {
  constructor(
    private readonly home: Home,
    private readonly cwd: string = process.cwd(),
  ) {}

  async resolveRoot(): Promise<string> {
    let dir = this.cwd;
    while (true) {
      if (await this.hasAnyMarker(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return this.cwd;
      dir = parent;
    }
  }

  private async hasAnyMarker(dir: string): Promise<boolean> {
    for (const file of AGENT_FILE_CANDIDATES) {
      if (await this.exists(path.join(dir, file))) return true;
    }
    for (const skillsDir of SKILLS_DIR_CANDIDATES) {
      if (await this.exists(path.join(dir, skillsDir))) return true;
    }
    return false;
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  async getPaths(): Promise<WorkspacePaths> {
    const root = await this.resolveRoot();
    const agentFilePaths: string[] = [];
    const skillsDirs: string[] = [];

    for (const file of AGENT_FILE_CANDIDATES) {
      const p = path.join(root, file);
      if (await this.exists(p)) agentFilePaths.push(p);
    }
    for (const skillsDir of SKILLS_DIR_CANDIDATES) {
      const p = path.join(root, skillsDir);
      if (await this.exists(p)) skillsDirs.push(p);
    }

    return { root, cubeDir: path.join(root, ".cube"), skillsDirs, agentFilePaths };
  }

  async isTrusted(): Promise<boolean> {
    const root = await this.resolveRoot();
    const registry = await WorkspaceRegistryStore(this.home).read();
    return registry.workspaces.some((w) => w.path === root);
  }

  async trust(): Promise<void> {
    const root = await this.resolveRoot();
    await WorkspaceRegistryStore(this.home).update((reg) => {
      if (reg.workspaces.some((w) => w.path === root)) return reg;
      return {
        workspaces: [...reg.workspaces, { path: root, trustedAt: new Date().toISOString() }],
      };
    });
  }

  async untrust(): Promise<void> {
    const root = await this.resolveRoot();
    await WorkspaceRegistryStore(this.home).update((reg) => ({
      workspaces: reg.workspaces.filter((w) => w.path !== root),
    }));
  }
}

export function Workspace(home: Home, cwd?: string): WorkspaceManager {
  return new WorkspaceManager(home, cwd);
}
