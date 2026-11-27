import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTool, type ToolPayloadTransformContext } from "@mastra/core/tools";
import { z } from "zod";
import { resolveWorkspacePath } from "./file.tools.js";
import { DEFAULT_BACKGROUND_TASKS, DEFAULT_WORKSPACE_ONLY, DEFAULT_COMMAND_TRUNCATION } from "@cube/workspace";
import { CommandOutputStore, type CommandOutput, type OutputPage, type OutputPolicy } from "./command-output.js";

export const COMMAND_SHELL = process.platform === "win32"
  ? join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "/bin/sh";
export const commandResultSchema = z.object({
  kind: z.literal("command"),
  command: z.string(),
  reason: z.string(),
  cwd: z.string(),
  process_id: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled", "timed_out"]),
  output: z.string(),
  exit_code: z.number().nullable(),
  truncated: z.boolean(),
  log_available: z.boolean().optional(),
  output_complete: z.boolean().optional(),
  output_warning: z.string().optional(),
  read_more: z.object({ tool: z.literal("manage_task"), action: z.literal("get"), id: z.string(), cursor: z.number() }).optional(),
});
export type CommandResult = z.infer<typeof commandResultSchema>;
export type ProcessRecord = {
  id: string;
  result: CommandResult;
  workspaceRoot: string;
  threadId?: string;
  runId?: string;
  toolCallId?: string;
  createdAt: number;
  completedAt?: number;
  detached: boolean;
  timeoutMs: number | null;
};
export type ProcessRegistry = {
  list(): ProcessRecord[];
  get(id: string, tail?: number): ProcessRecord;
  stop(id: string): Promise<ProcessRecord>;
  subscribe(listener: (record: ProcessRecord) => void): () => void;
  readOutput?(id: string, cursor?: number, limit?: number): Promise<OutputPage>;
};
type ProcessEntry = {
  record: Omit<ProcessRecord, "result">;
  child?: ChildProcess;
  start: () => void;
  result: CommandResult;
  output: CommandOutput;
  tail: number;
  refreshTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
  completion: Promise<void>;
  finish: () => void;
  terminate?: Promise<void>;
};
const commandInput = z.object({
  command: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(500),
  cwd: z.string().optional(),
  timeout: z
    .number()
    .positive()
    .max(600)
    .nullable()
    .optional()
    .describe("Deadline in seconds. Defaults to 120 for foreground, configured deadline for background. null disables the deadline only for background: true."),
  tail: z.number().int().min(1).max(2000).optional(),
  background: z.boolean().default(false),
});
const manageTaskActionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({
    action: z.literal("get"), id: z.string().uuid(),
    cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(2000).optional(),
  }).strict(),
  z.object({ action: z.literal("kill"), id: z.string().uuid() }).strict(),
]);
// OpenAI requires an object at the schema root; the pipe retains per-action validation.
const manageTaskInput = z.object({
  action: z.enum(["list", "get", "kill"]),
  ...manageTaskActionInput.options[1].omit({ action: true }).partial().shape,
}).strict().pipe(manageTaskActionInput);
export type ManageTaskInput = z.infer<typeof manageTaskInput>;

export function createCommandTools(
  root: string,
  workspaceOnly: boolean | (() => boolean) = DEFAULT_WORKSPACE_ONLY,
  background: { enabled: boolean; concurrency: number; timeout_ms: number } = DEFAULT_BACKGROUND_TASKS,
  projectRoot = root,
  outputOptions: { store?: CommandOutputStore; cacheDir?: string; policy?: OutputPolicy } = {},
) {
  const isWorkspaceOnly = () => typeof workspaceOnly === "function" ? workspaceOnly() : workspaceOnly;
  const processes = new Map<string, ProcessEntry>();
  const archived = new Map<string, ProcessRecord>();
  const runtimeId = randomUUID();
  const outputStore = outputOptions.store ?? new CommandOutputStore(outputOptions.cacheDir ?? join(tmpdir(), `cube-tool-output-${runtimeId}`));
  const outputPolicy = outputOptions.policy ?? DEFAULT_COMMAND_TRUNCATION;
  const listeners = new Set<(record: ProcessRecord) => void>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let taskHandler: ((input: ManageTaskInput, threadId: string) => Promise<unknown>) | undefined;
  const view = (entry: ProcessEntry, tail: number): CommandResult => {
    return entry.closed ? { ...entry.result } : { ...entry.result, ...entry.output.preview(tail) };
  };
  const find = (id: string) => {
    const entry = processes.get(id);
    if (!entry)
      throw new Error(
        "Unknown or expired process handle. Only processes started by this Cube runtime are accessible.",
      );
    return entry;
  };
  const snapshot = (entry: ProcessEntry, tail = 200): ProcessRecord => ({
    ...entry.record, result: view(entry, tail),
  });
  const emit = (entry: ProcessEntry) => {
    for (const listener of listeners) listener(snapshot(entry));
  };
  const dispatch = () => {
    if (disposed) return;
    let running = [...processes.values()].filter(
      (entry) => entry.record.detached && !entry.closed && entry.result.status !== "pending",
    ).length;
    for (const entry of processes.values()) {
      if (running >= background.concurrency) break;
      if (!entry.closed && entry.result.status === "pending") {
        running++;
        entry.start();
      }
    }
  };
  const close = async (entry: ProcessEntry, code: number | null) => {
    if (entry.closed) return;
    entry.closed = true;
    clearTimeout(entry.refreshTimer);
    await entry.output.finish();
    Object.assign(entry.result, entry.output.preview(entry.tail));
    entry.output.release();
    entry.record.completedAt = Date.now();
    entry.result.exit_code = code;
    if (entry.result.status === "running")
      entry.result.status = code === 0 ? "completed" : "failed";
    const completed = [...processes.entries()].filter(([, process]) => process.closed);
    for (const [id, old] of completed.slice(0, Math.max(0, completed.length - 100))) {
      if (old.output.spilled) archived.set(id, { ...snapshot(old), result: { ...old.result, output: "" } });
      outputStore.forget(id);
      processes.delete(id);
    }
    emit(entry);
    entry.finish();
    dispatch();
  };

  function terminate(entry: ProcessEntry, status: "cancelled" | "timed_out"): Promise<void> {
    if (entry.closed) return Promise.resolve();
    if (entry.terminate) return entry.terminate;
    entry.result.status = status;
    if (!entry.child) {
      return close(entry, null);
    }
    const child = entry.child;
    entry.terminate = (async () => {
      const pid = child.pid;
      if (pid) {
        if (
          process.platform === "win32" &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          await new Promise<void>((done, reject) => {
            const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
              timeout: 5000,
            });
            killer.once("error", reject);
            killer.once("close", (code) =>
              code === 0 || entry.closed
                ? done()
                : reject(new Error(`Could not terminate process tree (${code}).`)),
            );
          });
          // PowerShell can spawn a native child while taskkill enumerates the tree.
          // The child's parent ID remains queryable after the shell exits.
          await Promise.race([entry.completion, new Promise(resolve => setTimeout(resolve, 100))]);
          if (!entry.closed) {
            await new Promise<void>((done, reject) => {
              const killer = spawn(COMMAND_SHELL, ["-NoProfile", "-NonInteractive", "-Command",
                `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${pid}' | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F | Out-Null }`], {
                windowsHide: true, stdio: "ignore", timeout: 5000,
              });
              killer.once("error", reject);
              killer.once("close", code => code === 0 || entry.closed ? done() : reject(new Error(`Could not terminate remaining child processes (${code}).`)));
            });
          }
        } else if (process.platform !== "win32") {
          try {
            process.kill(-pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      }
      await Promise.race([
        entry.completion,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Process termination did not close its output streams.")),
            5000,
          );
          timer.unref();
          void entry.completion.then(() => clearTimeout(timer));
        }),
      ]);
    })().catch(async (error) => {
      entry.result.status = "failed";
      const message = `\nCould not confirm process-tree termination: ${error instanceof Error ? error.message : String(error)}`;
      await entry.output.append(Buffer.from(message));
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      await close(entry, child.exitCode);
      entry.terminate = undefined;
      throw error;
    });
    return entry.terminate;
  }

  const approval = async ({ input }: ToolPayloadTransformContext) => {
    const args = commandInput.parse(input);
    return { ...args, cwd: await resolveWorkspacePath(root, args.cwd ?? ".", isWorkspaceOnly()) };
  };
  const transform = {
    approval,
    input: ({ input }: ToolPayloadTransformContext) => input,
    inputDelta: ({ inputTextDelta }: ToolPayloadTransformContext) => inputTextDelta,
    output: ({ output }: ToolPayloadTransformContext) => output,
    error: ({ error }: ToolPayloadTransformContext) =>
      error instanceof Error ? error.message : error,
  };

  const execute_command = createTool({
    id: "execute_command",
    description: `Run a non-interactive ${process.platform === "win32" ? "Windows PowerShell 5.1 (-NoProfile -NonInteractive)" : "POSIX /bin/sh"} command. Explain its purpose in reason. Omitted/false background waits for the actual result. background:true runs builds/tests or servers in the background and returns a process_id (pending/running), not evidence of success. Inspect/stop that same ID with manage_task; completion/failure is delivered automatically. Do independent work or end your response while waiting; do not repeatedly poll. Foreground timeout defaults to 120 seconds; background uses the configured deadline. timeout:null disables the deadline only for background:true. cwd is not an OS sandbox.`,
    inputSchema: commandInput,
    outputSchema: commandResultSchema,
    transform: { display: transform, transcript: transform },
    execute: async (input, context) => {
      if (input.timeout === null && !input.background)
        throw new Error("timeout: null requires background: true.");
      if (input.background && !background.enabled)
        throw new Error("Background commands are disabled in config.yaml.");
      if (disposed) throw new Error("Cube command runtime is closed.");
      context.abortSignal?.throwIfAborted();
      const cwd = await resolveWorkspacePath(root, input.cwd ?? ".", isWorkspaceOnly());
      if (!(await stat(cwd)).isDirectory()) throw new Error("Command cwd must be a directory.");
      if (disposed) throw new Error("Cube command runtime is closed.");
      context.abortSignal?.throwIfAborted();
      if ([...processes.values()].filter((p) => !p.closed).length >= 32)
        throw new Error("32 processes are already active; stop one before starting another.");
      const id = randomUUID();
      const tail = input.tail ?? outputPolicy.max_lines;
      const output = outputStore.create(id, context.agent?.threadId ?? runtimeId, {
        max_bytes: input.background ? Math.min(outputPolicy.max_bytes, 16 * 1024) : outputPolicy.max_bytes,
        max_lines: input.background ? Math.min(tail, 200) : tail,
      });
      const result: CommandResult = {
        kind: "command",
        command: input.command,
        reason: input.reason,
        cwd,
        process_id: id,
        status: input.background ? "pending" : "running",
        output: "",
        exit_code: null,
        truncated: false,
      };
      let finish!: () => void;
      const completion = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const timeoutMs = input.timeout === null ? null : input.timeout !== undefined
        ? input.timeout * 1000 : input.background ? background.timeout_ms || null : 120_000;
      const entry: ProcessEntry = {
        record: {
          id, workspaceRoot: projectRoot, threadId: context.agent?.threadId,
          toolCallId: context.agent?.toolCallId,
          runId: context.requestContext?.get("cubeBackgroundRunId") as string | undefined,
          createdAt: Date.now(), detached: input.background, timeoutMs,
        },
        start: () => {
          result.status = "running";
          const windows = process.platform === "win32";
          const args = windows
            ? ["-NoProfile", "-NonInteractive", "-Command",
              `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $ErrorActionPreference = 'Stop'; & {\n${input.command}\n}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`]
            : ["-c", input.command];
          const child = entry.child = spawn(COMMAND_SHELL, args, {
            cwd,
            windowsHide: true,
            detached: !windows,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const stop = (status: "cancelled" | "timed_out") => {
            void terminate(entry, status).catch(() => undefined);
          };
          const timer = timeoutMs === null ? undefined : setTimeout(() => stop("timed_out"), timeoutMs);
          timer?.unref();
          const cancel = () => stop("cancelled");
          let writes = 0;
          const append = (chunk: Buffer) => {
            child.stdout?.pause(); child.stderr?.pause(); writes++;
            void output.append(chunk).then(() => {
              if (!entry.refreshTimer && !entry.closed) {
                entry.refreshTimer = setTimeout(() => { entry.refreshTimer = undefined; if (!entry.closed) emit(entry); }, 50);
                entry.refreshTimer.unref();
              }
            }).finally(() => {
              if (--writes === 0) { child.stdout?.resume(); child.stderr?.resume(); }
            });
          };
          child.stdout?.on("data", append);
          child.stderr?.on("data", append);
          child.once("error", (error) => {
            result.status = "failed";
            append(Buffer.from(error.message));
          });
          child.once("close", (code) => {
            clearTimeout(timer);
            context.abortSignal?.removeEventListener("abort", cancel);
            void close(entry, code);
          });
          // Background jobs outlive the tool's turn; only foreground follows its abort signal.
          if (!input.background) {
            context.abortSignal?.addEventListener("abort", cancel, { once: true });
            if (context.abortSignal?.aborted) cancel();
          }
          emit(entry);
        },
        result,
        output,
        tail,
        closed: false,
        completion,
        finish,
      };
      processes.set(id, entry);
      emit(entry);
      if (input.background) {
        dispatch();
        return view(entry, tail);
      }
      entry.start();
      await completion;
      return view(entry, tail);
    },
  });
  const manage_task = createTool({
    id: "manage_task",
    description: 'Manage command processes in this conversation, not subagents. list/kill concern background jobs. get also reads owned foreground output: {"action":"get","id":"<process UUID>","cursor":0,"limit":200} reads preserved output from the beginning. Without cursor, get returns recent output. Follow next_cursor for more stored bytes; each page is at most 16 KiB/2000 lines. Use process_id, never an OS PID or path. Truncated results include read_more; read missing evidence instead of rerunning the command. output_complete means capture finished successfully, not that the command succeeded. Running EOF is not completion. Completion is delivered automatically; do not repeatedly poll. Logs belong to this runtime and /exit removes them; historical saved previews have no continuation.',
    inputSchema: manageTaskInput,
    execute: async (input, context) => {
      const threadId = context.agent?.threadId;
      if (!threadId) throw new Error("Task management requires a calling thread.");
      if (!taskHandler) throw new Error("Task management is unavailable in this runtime.");
      return taskHandler(input, threadId);
    },
  });
  return {
    outputStore,
    tools: { execute_command, manage_task },
    setTaskHandler: (handler: NonNullable<typeof taskHandler>) => { taskHandler = handler; },
    processes: {
      list: () => [...processes.values()].map((entry) => snapshot(entry)),
      get: (id, tail = 200) => archived.has(id) ? structuredClone(archived.get(id)!) : snapshot(find(id), Math.max(1, Math.min(2000, tail))),
      readOutput: (id, cursor, limit) => outputStore.read(id, cursor, limit),
      stop: async (id) => {
        const entry = find(id);
        await terminate(entry, "cancelled");
        return snapshot(entry);
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    } satisfies ProcessRegistry,
    dispose: () => {
      disposed = true;
      disposal ??= (async () => {
        const outcomes = await Promise.allSettled(
          [...processes.values()].map((entry) => terminate(entry, "cancelled")),
        );
        const failed = outcomes.find((outcome) => outcome.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        processes.clear();
        archived.clear();
        listeners.clear();
        if (!outputOptions.store) await outputStore.dispose();
      })();
      return disposal;
    },
  };
}
