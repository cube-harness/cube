import path from "node:path";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { PermissionStore } from "./store/store.js";
import { withFileLock } from "./store/atomic-write.js";
import type { WorkspacePermission } from "./schemas/permission.schema.js";
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
  scope: string;
  content: string;
}

const pathKey = (value: string): string => {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export class WorkspaceManager {
  constructor(
    private readonly home: HomeManager,
    private readonly cwd: string = process.cwd(),
  ) {}

  async resolveRoot(): Promise<string> {
    return this.cwd;
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async tryRead(p: string, scope = path.dirname(p)): Promise<ContextFile | null> {
    try {
      const content = (await readFile(p, "utf8")).trim();
      return content ? { path: p, scope, content } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async getPaths(): Promise<CubeProject> {
    const root = await this.resolveRoot();
    const agentFilePaths: string[] = [];
    const skillsDirs: string[] = [];

    const agentPath = path.join(root, WORKSPACE_FILES.CONTEXT);
    if (await this.exists(agentPath)) agentFilePaths.push(agentPath);
    for (const skillsDir of WORKSPACE_PATHS.SKILLS) {
      const p = path.join(root, skillsDir);
      if (await this.exists(p)) skillsDirs.push(p);
    }

    return { root, cubeDir: path.join(root, GLOBAL_ROOT), skillsDirs, agentFilePaths };
  }

  /** Read applicable AGENTS.md files from cwd up to the workspace root. */
  async resolveContextFiles(explored?: Set<string>): Promise<ContextFile[]> {
    const root = await this.resolveRoot();
    const collected: ContextFile[] = [];

    // Closest directory first; do not discover unrelated descendants.
    let dir = this.cwd;
    while (true) {
      const file = await this.tryRead(path.join(dir, WORKSPACE_FILES.CONTEXT));
      if (file) collected.push(file);
      explored?.add(pathKey(dir));
      if (dir === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    // 2. nested: .agents/AGENTS.md, .cube/AGENTS.md, .claude/AGENTS.md, .codex/AGENTS.md — chỉ check ở root
    for (const toolDir of WORKSPACE_PATHS.ROOT) {
      const file = await this.tryRead(path.join(root, toolDir, CONTEXT_FILE), root);
      if (file) collected.push(file);
      explored?.add(pathKey(path.join(root, toolDir)));
    }

    return collected;
  }

  /** Discover only ancestors of touched paths; cache both loaded files and misses. */
  async discoverContextFiles(
    paths: readonly string[],
    explored: Set<string>,
    root: string,
  ): Promise<ContextFile[]> {
    const sources: ContextFile[] = [];
    let realRoot: string | undefined;
    for (const input of paths) {
      const target = path.resolve(root, input);
      if (!isWithin(root, target) || explored.has(pathKey(target))) continue;
      const info = await stat(target).catch((error) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
        throw error;
      });
      let dir = info?.isDirectory() ? target : path.dirname(target);
      while (isWithin(root, dir) && !explored.has(pathKey(dir))) {
        realRoot ??= await realpath(root);
        const source = await this.readScopedContext(path.join(dir, CONTEXT_FILE), root, realRoot);
        if (source) sources.push(source);
        // Cache misses too: new/changed instructions require an explicit reload.
        explored.add(pathKey(dir));
        if (pathKey(dir) === pathKey(root)) break;
        dir = path.dirname(dir);
      }
    }
    return sources;
  }

  /** Restart refresh of known project sources, with current filesystem boundaries. */
  async readContextSources(paths: readonly string[]): Promise<ContextFile[]> {
    const root = await this.resolveRoot();
    const realRoot = await realpath(root);
    const sources: ContextFile[] = [];
    const seen = new Set<string>();
    for (const sourcePath of paths) {
      if (seen.has(pathKey(sourcePath))) continue;
      seen.add(pathKey(sourcePath));
      const source = await this.readScopedContext(sourcePath, root, realRoot);
      if (source) sources.push(source);
    }
    return sources;
  }

  private async readScopedContext(
    sourcePath: string,
    root: string,
    realRoot: string,
  ): Promise<ContextFile | null> {
    if (!isWithin(root, sourcePath) || path.basename(sourcePath).toLowerCase() !== "agents.md") {
      return null;
    }
    try {
      if (!isWithin(realRoot, await realpath(sourcePath))) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return this.tryRead(sourcePath);
  }

  async getPermission(): Promise<WorkspacePermission | undefined> {
    const root = await realpath(await this.resolveRoot());
    const registry = await PermissionStore(this.home).read();
    return registry.workspaces.find((entry) => pathKey(entry.path) === pathKey(root));
  }

  async setTrust(trusted: boolean): Promise<void> {
    const root = await realpath(await this.resolveRoot());
    await withFileLock(this.home.getPermissionPath(), () =>
      PermissionStore(this.home).update((registry) => {
        const previous = registry.workspaces.find((entry) => pathKey(entry.path) === pathKey(root));
        return {
          workspaces: [
            ...registry.workspaces.filter((entry) => pathKey(entry.path) !== pathKey(root)),
            { path: root, trusted, permissions: previous?.permissions ?? {} },
          ],
        };
      }),
    );
  }
}

export function CubeWorkspace(home: HomeManager, cwd?: string): WorkspaceManager {
  return new WorkspaceManager(home, cwd);
}
