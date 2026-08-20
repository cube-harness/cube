import os from "node:os";
import path from "node:path";
import { access, mkdir } from "node:fs/promises";
import { HOME_FILES, HOME_PATHS, HOME_LIMITS } from "./constants.js";

export interface HomeOptions {
  cubeHome?: string;
  userHome?: string;
}

export interface CubeWorkspacePaths {
  root: string;
  memoryDir: string;
  logDir: string;
  skillDir: string;
  memoryDb: string;
  soulFile: string;
  authFile: string;
  configFile: string;
  historyFile: string;
  mcpFile: string;
  modelCatalogFile: string;
  workspaceFile: string;
}

export class Home {
  private readonly userHome: string;
  private readonly root: string;

  constructor(options: HomeOptions = {}) {
    this.userHome = options.userHome?.trim() || os.homedir();
    const raw = options.cubeHome?.trim() || path.join(this.userHome, HOME_PATHS.home);
    this.root = path.resolve(raw);
  }

  getUserHome(): string {
    return this.userHome;
  }

  getRoot(): string {
    return this.root;
  }

  getMemoryDir(): string {
    return path.join(this.root, HOME_PATHS.memories);
  }

  getLogDir(): string {
    return path.join(this.root, HOME_PATHS.logs);
  }

  getSkillDir(): string {
    return path.join(this.root, HOME_PATHS.skills);
  }

  getMemoryDbPath(): string {
    return path.join(this.getMemoryDir(), HOME_FILES.memoryDb);
  }

  getSoulPath(): string {
    return path.join(this.root, HOME_FILES.soul);
  }

  getAuthPath(): string {
    return path.join(this.root, HOME_FILES.auth);
  }

  getConfigPath(): string {
    return path.join(this.root, HOME_FILES.config);
  }

  getHistoryPath(): string {
    return path.join(this.root, HOME_FILES.history);
  }

  getMcpPath(): string {
    return path.join(this.root, HOME_FILES.mcp);
  }

  getModelCatalogPath(): string {
    return path.join(this.root, HOME_FILES.modelCatalog);
  }

  getWorkspacePath(): string {
    return path.join(this.root, HOME_FILES.workspace);
  }

  getSoulMaxCharacters(): number {
    return HOME_LIMITS.soulMaxCharacters;
  }

  getPaths(): CubeWorkspacePaths {
    return {
      root: this.getRoot(),
      memoryDir: this.getMemoryDir(),
      logDir: this.getLogDir(),
      skillDir: this.getSkillDir(),
      memoryDb: this.getMemoryDbPath(),
      soulFile: this.getSoulPath(),
      authFile: this.getAuthPath(),
      configFile: this.getConfigPath(),
      historyFile: this.getHistoryPath(),
      mcpFile: this.getMcpPath(),
      modelCatalogFile: this.getModelCatalogPath(),
      workspaceFile: this.getWorkspacePath(),
    };
  }

  async ensure(): Promise<CubeWorkspacePaths> {
    await mkdir(this.getRoot(), { recursive: true });
    await mkdir(this.getMemoryDir(), { recursive: true });
    await mkdir(this.getLogDir(), { recursive: true });
    await mkdir(this.getSkillDir(), { recursive: true });
    return this.getPaths();
  }

  async exists(): Promise<boolean> {
    try {
      await access(this.getRoot());
      return true;
    } catch {
      return false;
    }
  }
}

export function CubeHome(options?: HomeOptions): Home {
  return new Home(options);
}

export function resolveCubeHome(options?: HomeOptions): string {
  return new Home(options).getRoot();
}
