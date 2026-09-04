import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { WorkspaceRegistryStore } from "./store/store.js";
import type { HomeManager } from "./home-manager.js";
import { WORKSPACE_PATHS, WORKSPACE_FILES, GLOBAL_ROOT, CONTEXT_FILE } from "./constants.js";

export interface CubeProject {
  root: string;
  cubeDir: string;
  skillsDirs: string[];
  agentFilePaths: string[];
}

export interface ContextFile {
  path: string;
  content: string;
}

export class WorkspaceManager {
  constructor(
    private readonly home: HomeManager,
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
    for (const name of WORKSPACE_FILES.CONTEXT) {
      if (await this.exists(path.join(dir, name))) return true;
    }
    for (const toolDir of WORKSPACE_PATHS.ROOT) {
      if (await this.exists(path.join(dir, toolDir))) return true;
    }
    for (const skillsDir of WORKSPACE_PATHS.SKILLS) {
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

  private async tryRead(p: string): Promise<ContextFile | null> {
    try {
      const content = (await readFile(p, "utf8")).trim();
      return content ? { path: p, content } : null;
    } catch {
      return null;
    }
  }

  async getPaths(): Promise<CubeProject> {
    const root = await this.resolveRoot();
    const agentFilePaths: string[] = [];
    const skillsDirs: string[] = [];

    for (const name of WORKSPACE_FILES.CONTEXT) {
      const p = path.join(root, name);
      if (await this.exists(p)) agentFilePaths.push(p);
    }
    for (const skillsDir of WORKSPACE_PATHS.SKILLS) {
      const p = path.join(root, skillsDir);
      if (await this.exists(p)) skillsDirs.push(p);
    }

    return { root, cubeDir: path.join(root, GLOBAL_ROOT), skillsDirs, agentFilePaths };
  }

  /** I/O thật: walk-up từ cwd đến root, đọc mọi context file (AGENTS.md/CLAUDE.md) có nội dung */
  async resolveContextFiles(): Promise<ContextFile[]> {
    const root = await this.resolveRoot();
    const collected: ContextFile[] = [];

    // 1. bare AGENTS.md/CLAUDE.md, walk-up từng cấp thư mục
    let dir = this.cwd;
    while (true) {
      for (const name of WORKSPACE_FILES.CONTEXT) {
        const file = await this.tryRead(path.join(dir, name));
        if (file) collected.unshift(file);
      }
      if (dir === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    // 2. nested: .agents/AGENTS.md, .cube/AGENTS.md, .claude/AGENTS.md, .codex/AGENTS.md — chỉ check ở root
    for (const toolDir of WORKSPACE_PATHS.ROOT) {
      const file = await this.tryRead(path.join(root, toolDir, CONTEXT_FILE));
      if (file) collected.push(file);
    }

    return collected;
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

export function CubeWorkspace(home: HomeManager, cwd?: string): WorkspaceManager {
  return new WorkspaceManager(home, cwd);
}
