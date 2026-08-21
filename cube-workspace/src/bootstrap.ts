import { access, copyFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { Home } from "./home.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HOME_FILES } from "./constants.js";

export const loadEnv = (searchDirs?: string[]): void => {
  const dirs = searchDirs || [
    process.env.INIT_CWD || process.cwd(),
    process.cwd(),
  ];

  for (const dir of dirs) {
    if (!dir) continue;
    const envPath = path.join(dir, ".env");
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed
              .slice(eqIdx + 1)
              .trim()
              .replace(/^["']+|["']+$/g, "")
              .trim();
            if (val) {
              process.env[key] = val;
            } else {
              delete process.env[key];
            }
          }
        }
      } catch {
        // Silently ignore if load fails
      }
    }
  }

  // Normalize provider environment variable aliases for AI SDK compatibility
  if (process.env.GOOGLE_API_KEY) {
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GOOGLE_API_KEY;
    }
    if (!process.env.GEMINI_API_KEY) {
      process.env.GEMINI_API_KEY = process.env.GOOGLE_API_KEY;
    }
  }
};

export class Bootstrap {
  constructor(private readonly home: Home) {}

  async run(): Promise<void> {
    await this.home.ensure();
    loadEnv([
      this.home.getRoot(),
      process.env.INIT_CWD || process.cwd(),
      process.cwd(),
    ]);
    await this.seedFromTemplate(HOME_FILES.config, this.home.getConfigPath());
    await this.seedFromTemplate(HOME_FILES.auth, this.home.getAuthPath());
    await this.seedFromTemplate(HOME_FILES.mcp, this.home.getMcpPath());
    await this.seedFromTemplate(HOME_FILES.workspace, this.home.getWorkspacePath());
    await this.seedFromTemplate(HOME_FILES.soul, this.home.getSoulPath());
    await this.seedFromTemplate(HOME_FILES.history, this.home.getHistoryPath());
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

export function createBootstrap(home: Home): Bootstrap {
  return new Bootstrap(home);
}
