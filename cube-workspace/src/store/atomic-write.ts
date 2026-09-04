import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export type AtomicWriteOptions = {
  mode?: number;
};

export const atomicWriteFile = async (
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> => {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, content, {
      encoding: "utf8",
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    await rename(tmpPath, filePath);
    if (options.mode !== undefined && process.platform !== "win32") {
      await chmod(filePath, options.mode);
    }
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
};
