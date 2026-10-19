import os from "node:os";
import path from "node:path";
import { access, mkdir } from "node:fs/promises";
import { HOME_FILES, HOME_PATHS, HOME_LIMITS } from "./constants.js";

export interface HomeOptions {
  cubeHome?: string;
  userHome?: string;
}

export interface CubeRoot {
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
  permissionFile: string;
}

export class HomeManager {
  private readonly userHome: string;
  private readonly root: string;

  constructor(options: HomeOptions = {}) {
    this.userHome = options.userHome?.trim() || os.homedir();
    const raw = options.cubeHome?.trim() || path.join(this.userHome, HOME_PATHS.ROOT);
    this.root = path.resolve(raw);
  }

  getUserHome(): string {
    return this.userHome;
  }

  getRoot(): string {
    return this.root;
  }

  getMemoryDir(): string {
    return path.join(this.root, HOME_PATHS.MEMORIES);
  }

  getLogDir(): string {
    return path.join(this.root, HOME_PATHS.LOGS);
  }

  getSkillDir(): string {
    return path.join(this.root, HOME_PATHS.SKILLS);
  }

  getAgentsPath(): string {
    return path.join(this.root, HOME_FILES.AGENTS);
  }

  getMemoryDbPath(): string {
    return path.join(this.getMemoryDir(), HOME_FILES.MEMORY_DB);
  }

  getMemoryRetrievalDir(): string {
    return path.join(this.root, "cache", "memory-retrieval");
  }

  getToolOutputDir(): string {
    return path.join(this.root, "cache", "tool-output");
  }

  getSoulPath(): string {
    return path.join(this.root, HOME_FILES.SOUL);
  }

  getAuthPath(): string {
    return path.join(this.root, HOME_FILES.AUTH);
  }

  getConfigPath(): string {
    return path.join(this.root, HOME_FILES.CONFIG);
  }

  getHistoryPath(): string {
    return path.join(this.root, HOME_FILES.HISTORY);
  }

  getMcpPath(): string {
    return path.join(this.root, HOME_FILES.MCP);
  }

  getModelCatalogPath(): string {
    return path.join(this.root, HOME_FILES.MODEL_CATALOG);
  }

  getPermissionPath(): string {
    return path.join(this.root, HOME_FILES.PERMISSION);
  }

  getSoulMaxCharacters(): number {
    return HOME_LIMITS.SOUL_MAX_CHARACTERS;
  }

  getModelCatalogTtlMs(): number {
    return HOME_LIMITS.MODEL_CATALOG_TTL_MS;
  }

  getPaths(): CubeRoot {
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
      permissionFile: this.getPermissionPath(),
    };
  }

  async ensure(): Promise<CubeRoot> {
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

export function CubeHome(options?: HomeOptions): HomeManager {
  return new HomeManager(options);
}
