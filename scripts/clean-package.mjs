import { existsSync, rmSync } from "node:fs";
import path from "node:path";

const packageDirectory = process.cwd();
const packageJson = path.join(packageDirectory, "package.json");
if (!existsSync(packageJson)) {
  throw new Error(`Refusing to clean a directory without package.json: ${packageDirectory}`);
}

rmSync(path.join(packageDirectory, "dist"), { recursive: true, force: true });
rmSync(path.join(packageDirectory, "tsconfig.tsbuildinfo"), { force: true });
