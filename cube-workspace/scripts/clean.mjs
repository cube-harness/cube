import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const buildInfo = fileURLToPath(new URL("../tsconfig.tsbuildinfo", import.meta.url));

rmSync(dist, { recursive: true, force: true });
rmSync(buildInfo, { force: true });
