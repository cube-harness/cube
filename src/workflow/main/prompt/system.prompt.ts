import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_SOUL = readFileSync(join(__dirname, "SOUL.md"), "utf-8").trim();
export const DEFAULT_AGENTS = readFileSync(join(__dirname, "AGENT.md"), "utf-8").trim();