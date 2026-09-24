import { lstat, mkdir, open, realpath, link, unlink } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createTool, type ToolPayloadTransformContext } from "@mastra/core/tools";
import { atomicWriteFile } from "@cube/workspace";
import { createTwoFilesPatch, diffLines } from "diff";
import { z } from "zod";
import { replace } from "./edit-text.js";
import { applyFilePatch, parsePatch } from "./apply-patch.js";

const FILE_LIMIT = 2 * 1024 * 1024;
const OPERATION_LIMIT = 8 * 1024 * 1024;
const OUTPUT_LIMIT = 64 * 1024;
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export const fileMutationResultSchema = z.object({
  kind: z.literal("file_changes"),
  status: z.enum(["proposed", "applied", "failed", "partial"]),
  summary: z.string(),
  changes: z.array(
    z.object({
      path: z.string(),
      operation: z.enum(["add", "update", "delete", "move"]),
      destination: z.string().optional(),
      diff: z.string(),
      added: z.number(),
      removed: z.number(),
      status: z.enum(["proposed", "applied", "failed", "not_applied"]),
      error: z.string().optional(),
      truncated: z.boolean(),
    }),
  ),
});
export type FileMutationResult = z.infer<typeof fileMutationResultSchema>;
export type FileChange = FileMutationResult["changes"][number];

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export async function resolveWorkspacePath(root: string, input: string): Promise<string> {
  if (input.includes("\0")) throw new Error("Paths must not contain NUL.");
  const path = resolve(root, input);
  if (!inside(resolve(root), path) || path.slice(parse(path).root.length).includes(":")) {
    throw new Error(`Path is outside the workspace or uses an unsupported stream: ${input}`);
  }
  const actualRoot = await realpath(root);
  let parent = path;
  const suffix: string[] = [];
  while (true) {
    try {
      const actual = await realpath(parent);
      if (!inside(actualRoot, actual))
        throw new Error(`Symlink target is outside the workspace: ${input}`);
      return resolve(actual, ...suffix);
    } catch (error) {
      if (!missing(error)) throw error;
      const entry = await lstat(parent).catch((e) => {
        if (!missing(e)) throw e;
        return undefined;
      });
      if (entry?.isSymbolicLink()) throw new Error(`Broken symbolic link: ${input}`);
      const next = dirname(parent);
      if (next === parent) throw error;
      suffix.unshift(relative(next, parent));
      parent = next;
    }
  }
}

type Snapshot = { text: string; mode: number; ino: number; dev: number; mtimeMs: number };
async function snapshot(path: string): Promise<Snapshot | undefined> {
  let handle;
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
    if (info.size > FILE_LIMIT) throw new Error(`File exceeds the 2 MiB edit limit: ${path}`);
    handle = await open(path, "r");
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > FILE_LIMIT) throw new Error(`File exceeds the 2 MiB edit limit: ${path}`);
    const bytes = buffer.subarray(0, size);
    if (bytes.includes(0)) throw new Error(`Binary file editing is not supported: ${path}`);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { text, mode: info.mode, ino: info.ino, dev: info.dev, mtimeMs: info.mtimeMs };
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

function textParts(text: string) {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = text.slice(bom.length);
  const crlf = body.includes("\r\n");
  if (
    body.replaceAll("\r\n", "").includes("\r") ||
    (crlf && body.replaceAll("\r\n", "").includes("\n"))
  ) {
    throw new Error(
      "Mixed or unsupported line endings; normalize the file explicitly before editing.",
    );
  }
  return { bom, body, ending: crlf ? "\r\n" : "\n" };
}

type PreparedFile = {
  path: string;
  requestedPath: string;
  destination?: string;
  requestedDestination?: string;
  before?: Snapshot;
  after?: string;
  change: FileChange;
};
type Proposal = { files: PreparedFile[]; preview: FileMutationResult };

const editInput = z.object({
  path: z.string().min(1),
  old_string: z.string().max(FILE_LIMIT),
  new_string: z.string().max(FILE_LIMIT),
  replace_all: z.boolean().default(false),
});
const writeInput = z.object({
  path: z.string().min(1),
  content: z.string().max(FILE_LIMIT),
  overwrite: z.boolean().default(false),
});
const patchInput = z.object({ patch: z.string().min(1).max(OPERATION_LIMIT) });

export function createFileTools(root: string) {
  const pending = new Map<string, Promise<Proposal>>();
  const ready = new Set<string>();
  // ponytail: serialize workspace mutations; use per-file locks only if write contention matters.
  let writes: Promise<unknown> = Promise.resolve();
  const displayPath = (path: string) => relative(root, path).replaceAll("\\", "/");
  const failure = (error: unknown): FileMutationResult => ({
    kind: "file_changes",
    status: "failed",
    summary: errorText(error),
    changes: [],
  });
  const boundDiffs = (changes: FileChange[]) => {
    let remaining = OUTPUT_LIMIT;
    for (const change of changes) {
      const bytes = Buffer.from(change.diff);
      if (bytes.length > remaining) {
        change.diff = new TextDecoder().decode(bytes.subarray(0, remaining), { stream: true });
        change.truncated = true;
      }
      remaining = Math.max(0, remaining - bytes.length);
    }
  };

  async function prepare(id: string, args: unknown): Promise<Proposal> {
    const files: PreparedFile[] = [];
    const targets = new Set<string>();
    let bytes = 0;
    async function add(
      requestedPath: string,
      operation: FileChange["operation"],
      content: (source?: Snapshot) => string | undefined,
      requestedDestination?: string,
    ) {
      const path = await resolveWorkspacePath(root, requestedPath);
      const destination =
        requestedDestination === undefined
          ? undefined
          : await resolveWorkspacePath(root, requestedDestination);
      for (const target of [path, destination].filter((p): p is string => p !== undefined)) {
        const key = process.platform === "win32" ? target.toLowerCase() : target;
        if (targets.has(key)) throw new Error(`Conflicting patch target: ${displayPath(target)}`);
        targets.add(key);
      }
      const before = await snapshot(path);
      if (operation === "add" && before) throw new Error(`File already exists: ${requestedPath}`);
      if (operation !== "add" && !before) throw new Error(`File not found: ${requestedPath}`);
      if (
        destination &&
        (await lstat(destination).then(
          () => true,
          (e) => {
            if (!missing(e)) throw e;
            return false;
          },
        ))
      )
        throw new Error(`Destination already exists: ${requestedDestination}`);
      const after = content(before);
      if (after?.includes("\0")) throw new Error("Binary mutation is not supported.");
      if (Buffer.byteLength(after ?? "") > FILE_LIMIT)
        throw new Error("Proposed file exceeds 2 MiB.");
      bytes += Buffer.byteLength(before?.text ?? "") + Buffer.byteLength(after ?? "");
      if (bytes > OPERATION_LIMIT) throw new Error("Operation exceeds 8 MiB; split the change.");
      const oldText = before?.text ?? "";
      let added = 0,
        removed = 0;
      for (const part of diffLines(oldText, after ?? "")) {
        if (part.added) added += part.count;
        if (part.removed) removed += part.count;
      }
      const diff = createTwoFilesPatch(
        displayPath(path),
        displayPath(destination ?? path),
        oldText,
        after ?? "",
      );
      files.push({
        path,
        requestedPath,
        destination,
        requestedDestination,
        before,
        after,
        change: {
          path: displayPath(path),
          destination: destination ? displayPath(destination) : undefined,
          operation,
          diff,
          added,
          removed,
          status: "proposed",
          truncated: false,
        },
      });
    }
    if (id === "edit_file") {
      const input = editInput.parse(args);
      if (input.old_string === input.new_string)
        throw new Error("No changes to apply: old_string and new_string are identical.");
      await add(input.path, input.old_string === "" ? "add" : "update", (source) => {
        if (!source) return input.new_string;
        const { body, bom, ending } = textParts(source.text);
        const normalize = (text: string) => text.replaceAll("\r\n", "\n").replaceAll("\n", ending);
        const next = replace(
          body,
          normalize(input.old_string),
          normalize(input.new_string),
          input.replace_all,
        );
        return (bom || (next.startsWith("\uFEFF") ? "\uFEFF" : "")) + next.replace(/^\uFEFF/, "");
      });
    } else if (id === "write_file") {
      const input = writeInput.parse(args);
      const path = await resolveWorkspacePath(root, input.path);
      const exists = await lstat(path).then(
        () => true,
        (e) => {
          if (!missing(e)) throw e;
          return false;
        },
      );
      if (exists && !input.overwrite)
        throw new Error("File exists; use overwrite: true for an intentional full replacement.");
      await add(input.path, exists ? "update" : "add", (source) => {
        if (!source) return input.content;
        const { bom, ending } = textParts(source.text);
        return (
          (bom || (input.content.startsWith("\uFEFF") ? "\uFEFF" : "")) +
          input.content
            .replace(/^\uFEFF/, "")
            .replaceAll("\r\n", "\n")
            .replaceAll("\n", ending)
        );
      });
    } else {
      const { patch } = patchInput.parse(args);
      const { hunks } = parsePatch(patch.replaceAll("\r\n", "\n"));
      if (!hunks.length) throw new Error("Patch contains no file changes.");
      for (const hunk of hunks) {
        await add(
          hunk.path,
          hunk.type === "update" && hunk.move_path ? "move" : hunk.type,
          (source) => {
            if (hunk.type === "delete") return undefined;
            if (hunk.type === "add") return hunk.contents ? hunk.contents + "\n" : "";
            const { bom, body, ending } = textParts(source!.text);
            return (
              bom + applyFilePatch(body.replaceAll("\r\n", "\n"), hunk).replaceAll("\n", ending)
            );
          },
          hunk.type === "update" ? hunk.move_path : undefined,
        );
      }
    }
    boundDiffs(files.map((file) => file.change));
    return {
      files,
      preview: {
        kind: "file_changes",
        status: "proposed",
        summary: `${files.length} proposed file change(s).`,
        changes: files.map((f) => ({ ...f.change })),
      },
    };
  }

  async function validate(file: PreparedFile) {
    if ((await resolveWorkspacePath(root, file.requestedPath)) !== file.path)
      throw new Error(`Path target changed: ${file.requestedPath}`);
    const current = await snapshot(file.path);
    if (JSON.stringify(current) !== JSON.stringify(file.before))
      throw new Error(
        `File changed since preparation: ${file.change.path}. Read it and propose a fresh edit.`,
      );
    if (file.destination) {
      if ((await resolveWorkspacePath(root, file.requestedDestination!)) !== file.destination)
        throw new Error("Move destination changed.");
      if (
        await lstat(file.destination).then(
          () => true,
          (e) => {
            if (!missing(e)) throw e;
            return false;
          },
        )
      )
        throw new Error(`Move destination now exists: ${file.change.destination}`);
    }
  }

  async function publish(path: string, text: string, mode?: number) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(text, "utf8");
      await handle.close();
      // link is an exclusive publication: unlike rename it cannot clobber a destination.
      await link(temporary, path);
    } finally {
      await handle.close();
      await unlink(temporary).catch(() => undefined);
    }
  }

  async function commit(proposal: Proposal, signal?: AbortSignal): Promise<FileMutationResult> {
    const changes = proposal.files.map(
      (file): FileChange => ({ ...file.change, status: "not_applied" }),
    );
    let active = 0;
    try {
      signal?.throwIfAborted();
      for (const [index, file] of proposal.files.entries()) {
        active = index;
        await validate(file);
      }
      for (const [index, file] of proposal.files.entries()) {
        active = index;
        signal?.throwIfAborted();
        await validate(file);
        if (file.after === undefined) await unlink(file.path);
        else if (file.destination) {
          await publish(file.destination, file.after, file.before?.mode);
          try {
            await unlink(file.path);
          } catch (error) {
            const diff = createTwoFilesPatch(
              file.change.destination!,
              file.change.destination!,
              "",
              file.after,
            );
            changes[index] = {
              ...changes[index],
              operation: "add",
              path: file.change.destination!,
              destination: undefined,
              diff: Buffer.from(diff).subarray(0, OUTPUT_LIMIT).toString(),
              truncated: Buffer.byteLength(diff) > OUTPUT_LIMIT,
              added: diffLines("", file.after).reduce(
                (count, part) => count + (part.added ? part.count : 0),
                0,
              ),
              removed: 0,
              status: "applied",
              error: `Destination created; source still present: ${file.change.path}. ${errorText(error)}`,
            };
            throw error;
          }
        } else if (!file.before) await publish(file.path, file.after);
        else await atomicWriteFile(file.path, file.after, { mode: file.before.mode });
        changes[index].status = "applied";
      }
      return {
        kind: "file_changes",
        status: "applied",
        summary: changes
          .map(
            (c) =>
              `${c.operation}: ${c.path}${c.destination ? ` -> ${c.destination}` : ""} (+${c.added}/-${c.removed})`,
          )
          .join("\n"),
        changes,
      };
    } catch (error) {
      if (changes[active] && changes[active].status !== "applied") {
        changes[active].status = "failed";
        changes[active].error = errorText(error);
      }
      boundDiffs(changes);
      return {
        kind: "file_changes",
        status: changes.some((c) => c.status === "applied") ? "partial" : "failed",
        summary: `${errorText(error)}\n${changes.map((c) => `${c.status}: ${c.path}${c.error ? ` (${c.error})` : ""}`).join("\n")}`,
        changes,
      };
    }
  }

  const discardPreview = (id?: string) => {
    if (id) {
      pending.delete(id);
      ready.delete(id);
    } else {
      pending.clear();
      ready.clear();
    }
  };
  function mutation<S extends z.ZodObject>(id: string, inputSchema: S, description: string) {
    const approval = async ({ toolCallId, input }: ToolPayloadTransformContext) => {
      try {
        let entry = pending.get(toolCallId);
        if (!entry) {
          entry = prepare(id, input).then((proposal) => {
            if (proposal.preview.changes.some((c) => c.truncated))
              throw new Error(
                "Approval diff exceeds 64 KiB; split this change before requesting approval.",
              );
            if (pending.get(toolCallId) === entry) ready.add(toolCallId);
            return proposal;
          });
          pending.set(toolCallId, entry);
        }
        return { ...inputSchema.parse(input), preview: (await entry).preview };
      } catch (error) {
        return { ...inputSchema.parse(input), preview: failure(error) };
      }
    };
    const transform = {
      approval,
      input: ({ input }: ToolPayloadTransformContext) => input,
      inputDelta: ({ inputTextDelta }: ToolPayloadTransformContext) => inputTextDelta,
      output: ({ output }: ToolPayloadTransformContext) => output,
      error: ({ error }: ToolPayloadTransformContext) =>
        error instanceof Error ? error.message : error,
    };
    return createTool({
      id,
      description,
      inputSchema,
      outputSchema: fileMutationResultSchema,
      transform: { display: transform, transcript: transform },
      execute: async (input, context) => {
        const callId = context.agent?.toolCallId;
        try {
          const proposal = await ((callId && pending.get(callId)) || prepare(id, input));
          const result = writes.then(() => commit(proposal, context.abortSignal));
          writes = result.catch(() => undefined);
          return await result;
        } catch (error) {
          return failure(error);
        } finally {
          if (callId) discardPreview(callId);
        }
      },
      toModelOutput: (result) => ({ type: "text", value: result.summary }),
    });
  }

  return {
    tools: {
      edit_file: mutation(
        "edit_file",
        editInput,
        "Edit text using OpenCode's ordered matching strategies. Supply enough old text to identify the change; replace_all explicitly allows all matches. Empty old_string creates only a missing file.",
      ),
      write_file: mutation(
        "write_file",
        writeInput,
        "Create a UTF-8 file. To replace an existing file intentionally, set overwrite: true. Prefer edit_file for targeted changes.",
      ),
      apply_patch: mutation(
        "apply_patch",
        patchInput,
        "Apply a Codex-format patch: *** Begin Patch, *** Add/Update/Delete File: path, @@ hunks, optional *** Move to: path, *** End Patch. Supply raw patch text in the patch argument, not a unified diff or shell command.",
      ),
    },
    hasPreview: (id: string) => ready.has(id),
    discardPreview,
  };
}
