import { rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export const atomicWriteFile = async (filePath: string, content: string): Promise<void> => {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, filePath);
};