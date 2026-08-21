import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

export interface LoadCubeEnvOptions {
  cwd?: string;
  moduleUrl?: string;
  exists?: (candidate: string) => boolean;
  load?: (candidate: string) => void;
}

export const loadCubeEnv = (options: LoadCubeEnvOptions = {}): string | undefined => {
  const cwd = options.cwd ?? process.cwd();
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const exists = options.exists ?? existsSync;
  const load = options.load ?? loadEnvFile;
  const candidates = [
    path.resolve(cwd, ".env"),
    path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../..", ".env"),
  ];
  const envPath = [...new Set(candidates)].find(exists);

  if (envPath) load(envPath);
  return envPath;
};
