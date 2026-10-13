import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const MEMORY_BYTES = 256 * 1024;
const PAGE_BYTES = 16 * 1024;
export type OutputPage = {
  output: string; truncated: boolean; log_available: boolean; output_complete: boolean;
  next_cursor?: number; output_warning?: string;
  read_more?: { tool: "manage_task"; action: "get"; id: string; cursor: number };
};
export type OutputPolicy = { max_bytes: number; max_lines: number };

function utf8End(buffer: Buffer): number {
  if (!buffer.length) return 0;
  let start = buffer.length - 1;
  while (start > 0 && (buffer[start]! & 0xc0) === 0x80) start--;
  const byte = buffer[start]!;
  const size = byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1;
  return start + size > buffer.length ? start : buffer.length;
}

export function utf8Tail(buffer: Buffer, bytes: number): Buffer {
  let start = Math.max(0, buffer.length - bytes);
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return Buffer.from(buffer.subarray(start));
}

async function directory(path: string, create = false): Promise<void> {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch(async error => {
      if (!create || error.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      return lstat(current);
    });
    // Resolve host temp aliases (e.g. macOS /var), never links inside our cache.
    const temp = resolve(tmpdir());
    if (info.isSymbolicLink() && (temp === current || temp.startsWith(current + sep))) {
      current = await realpath(current);
      if ((await stat(current)).isDirectory()) continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe command output directory");
  }
}

export class CommandOutput {
  buffer = Buffer.alloc(0);
  private bytes = 0;
  private lines = 0;
  private file?: FileHandle;
  private identity?: { dev: number; ino: number };
  private path?: string;
  private pending = Promise.resolve();
  private complete = false;
  private warning?: string;

  constructor(readonly id: string, readonly threadId: string, private readonly root: string,
    private readonly policy: OutputPolicy) {}

  append(chunk: Buffer): Promise<void> {
    const write = this.pending.then(async () => {
      const prefix = this.buffer;
      if (chunk.length && !this.bytes) this.lines = 1;
      this.bytes += chunk.length;
      for (let at = chunk.indexOf(10); at >= 0; at = chunk.indexOf(10, at + 1)) this.lines++;
      this.buffer = utf8Tail(Buffer.concat([prefix, chunk]), MEMORY_BYTES);
      if (this.warning) return;
      try {
        if (!this.file && (this.bytes > this.policy.max_bytes || this.lines > this.policy.max_lines)) {
          await directory(join(this.root, this.threadId), true);
          const path = join(this.root, this.threadId, `${this.id}.log`);
          this.file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
          this.path = path;
          const { dev, ino } = await this.file.stat(); this.identity = { dev, ino };
          await this.write(prefix);
        }
        if (this.file) await this.write(chunk);
      } catch (error) {
        this.warning = `Full command output preservation unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
    this.pending = write;
    return write;
  }

  private async write(buffer: Buffer): Promise<void> {
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await this.file!.write(buffer, offset, buffer.length - offset);
      if (!bytesWritten) throw new Error("Command log write made no progress");
      offset += bytesWritten;
    }
  }

  preview(lines: number, bytes = this.policy.max_bytes): OutputPage {
    const buffer = utf8Tail(this.buffer, bytes);
    const decoder = new StringDecoder("utf8");
    const text = decoder.write(buffer) + (this.complete ? decoder.end() : "");
    const split = text.split(/\r?\n/), output = split.slice(-lines).join("\n");
    const truncated = this.bytes > buffer.length || split.length > lines;
    const log_available = !!this.path && !this.warning;
    return { output, truncated, log_available, output_complete: this.complete && !this.warning,
      ...(this.warning ? { output_warning: this.warning } : {}),
      ...(truncated && log_available ? { read_more: { tool: "manage_task", action: "get", id: this.id, cursor: 0 } as const } : {}) };
  }

  async finish(): Promise<void> {
    await this.pending;
    try { await this.file?.close(); } catch (error) { this.warning = `Command log close failed: ${String(error)}`; }
    this.file = undefined;
    this.complete = true;
  }

  release(): void { if (this.path) this.buffer = Buffer.alloc(0); }
  get spilled(): boolean { return !!this.path; }

  async read(cursor?: number, limit = 200): Promise<OutputPage> {
    await this.pending;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000 ||
      (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))) throw new Error("Invalid command output cursor/limit");
    if (!this.path || this.warning) {
      const preview = this.preview(limit, PAGE_BYTES);
      return { ...preview, ...(cursor !== undefined ? { log_available: false,
        output_warning: this.warning ?? "Full command output continuation is unavailable." } : {}) };
    }
    let handle: FileHandle | undefined;
    try {
      await directory(dirname(this.path));
      const entry = await lstat(this.path);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Unsafe command output source");
      handle = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (info.dev !== this.identity?.dev || info.ino !== this.identity?.ino) throw new Error("Command output source changed");
      let start = cursor ?? Math.max(0, info.size - PAGE_BYTES);
      if (start > info.size) throw new Error("Command output cursor exceeds stored output");
      const buffer = Buffer.alloc(Math.min(PAGE_BYTES, info.size - start));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let data = buffer.subarray(0, bytesRead);
      if (cursor !== undefined && data.length && (data[0]! & 0xc0) === 0x80) throw new Error("Command output cursor splits UTF-8");
      if (cursor === undefined) {
        let skip = 0; while (skip < data.length && (data[skip]! & 0xc0) === 0x80) skip++;
        start += skip; data = data.subarray(skip);
      }
      let end = this.complete && start + data.length === info.size ? data.length : utf8End(data), lines = 0;
      if (cursor !== undefined) for (let i = 0; i < end; i++) if (data[i] === 10 && ++lines === limit) { end = i + 1; break; }
      const text = data.subarray(0, end).toString("utf8");
      const output = cursor === undefined ? text.split(/\r?\n/).slice(-limit).join("\n") : text;
      const next = start + end;
      return { output, truncated: cursor === undefined ? info.size > Buffer.byteLength(output) : next < info.size,
        log_available: true, output_complete: this.complete,
        ...(cursor !== undefined && (next < info.size || !this.complete) ? { next_cursor: next } : {}),
        ...(cursor === undefined ? { read_more: { tool: "manage_task", action: "get", id: this.id, cursor: 0 } as const } : {}) };
    } finally { await handle?.close(); }
  }

  async remove(): Promise<void> {
    await this.finish();
    if (!this.path) return;
    await directory(dirname(this.path));
    const info = await lstat(this.path).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (info && !info.isSymbolicLink() && info.dev === this.identity?.dev && info.ino === this.identity?.ino) await unlink(this.path);
  }
}

export class CommandOutputStore {
  private readonly outputs = new Map<string, CommandOutput>();
  constructor(private readonly root: string) {}
  create(id: string, threadId: string, policy: OutputPolicy): CommandOutput {
    if (![id, threadId].every(value => /^[\w-]{1,128}$/.test(value))) throw new Error("Invalid command output owner");
    if (this.outputs.has(id)) throw new Error("Command output already exists");
    const output = new CommandOutput(id, threadId, resolve(this.root), policy);
    this.outputs.set(id, output); return output;
  }
  forget(id: string): void { if (!this.outputs.get(id)?.spilled) this.outputs.delete(id); }
  async read(id: string, cursor?: number, limit?: number): Promise<OutputPage> {
    const output = this.outputs.get(id);
    if (!output) throw new Error("Command output belongs to another or expired runtime");
    return output.read(cursor, limit);
  }
  async dispose(): Promise<void> {
    const dirs = new Set<string>();
    for (const output of this.outputs.values()) {
      await output.remove();
      if (output.spilled) dirs.add(join(this.root, output.threadId));
    }
    for (const dir of dirs.size ? [...dirs, this.root] : []) {
      await rmdir(dir).catch(error => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; });
    }
    this.outputs.clear();
  }
}
