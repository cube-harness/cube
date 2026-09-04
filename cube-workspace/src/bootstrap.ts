import { access, copyFile } from "node:fs/promises";
import { HomeManager } from "./home-manager.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HOME_FILES } from "./constants.js";

export class Bootstrap {
  constructor(private readonly home: HomeManager) {}

  async run(): Promise<void> {
    await this.home.ensure();
    await this.seedFromTemplate(HOME_FILES.CONFIG, this.home.getConfigPath());
    await this.seedFromTemplate(HOME_FILES.AUTH, this.home.getAuthPath());
    await this.seedFromTemplate(HOME_FILES.MCP, this.home.getMcpPath());
    await this.seedFromTemplate(HOME_FILES.WORKSPACE, this.home.getWorkspacePath());
    await this.seedFromTemplate(HOME_FILES.SOUL, this.home.getSoulPath());
    await this.seedFromTemplate(HOME_FILES.HISTORY, this.home.getHistoryPath());
  }

  private async fileExists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async seedFromTemplate(templateFile: string, destPath: string): Promise<void> {
    if (await this.fileExists(destPath)) return;
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    let srcFile = path.join(currentDir, "template", templateFile);
    if (!(await this.fileExists(srcFile))) {
      srcFile = path.join(currentDir, "..", "src", "template", templateFile);
    }
    await copyFile(srcFile, destPath);
  }
}

export function createBootstrap(home: HomeManager): Bootstrap {
  return new Bootstrap(home);
}
