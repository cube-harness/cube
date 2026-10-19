import { chmod, open, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type FileLockOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** Lock the complete read/modify/write operation, not only the final write. */
export const withFileLock = async <T>(
  filePath: string,
  operation: () => Promise<T>,
  { timeoutMs = 5000, signal }: FileLockOptions = {},
): Promise<T> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("File lock timeout must be a finite non-negative number");
  }
  const lockPath = `${resolve(filePath)}.lock`;
  const deadline = Date.now() + timeoutMs;
  let lock: FileHandle;
  while (true) {
    signal?.throwIfAborted();
    try {
      lock = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // ponytail: do not steal stale locks; explicit recovery after a crash.
        throw new Error(`File is locked: ${lockPath}. No update was started.`);
      }
      await delay(Math.min(25, remaining), undefined, { signal });
    }
  }
  try {
    signal?.throwIfAborted();
    return await operation();
  } finally {
    try {
      await lock.close();
    } finally {
      await unlink(lockPath);
    }
  }
};

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
