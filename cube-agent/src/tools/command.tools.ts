import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { createTool, type ToolPayloadTransformContext } from "@mastra/core/tools";
import { z } from "zod";
import { resolveWorkspacePath } from "./file.tools.js";

const MAX_OUTPUT = 256 * 1024;
export const commandResultSchema = z.object({
  kind: z.literal("command"),
  command: z.string(),
  reason: z.string(),
  cwd: z.string(),
  process_id: z.string(),
  status: z.enum(["running", "completed", "failed", "cancelled", "timed_out"]),
  output: z.string(),
  exit_code: z.number().nullable(),
  truncated: z.boolean(),
});
export type CommandResult = z.infer<typeof commandResultSchema>;
type ProcessEntry = {
  child: ChildProcess;
  result: CommandResult;
  buffer: Buffer;
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
    .default(120)
    .describe("Process deadline in seconds, including background execution."),
  tail: z.number().int().min(1).max(2000).default(200),
  background: z.boolean().default(false),
});
const processInput = z.object({
  process_id: z.string().uuid(),
  tail: z.number().int().min(1).max(2000).default(200),
});

export function createCommandTools(root: string) {
  const processes = new Map<string, ProcessEntry>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const view = (entry: ProcessEntry, tail: number): CommandResult => {
    const lines = entry.buffer.toString("utf8").split(/\r?\n/);
    return {
      ...entry.result,
      output: lines.slice(-tail).join("\n"),
      truncated: entry.result.truncated || lines.length > tail,
    };
  };
  const find = (id: string) => {
    const entry = processes.get(id);
    if (!entry)
      throw new Error(
        "Unknown or expired process handle. Only processes started by this Cube runtime are accessible.",
      );
    return entry;
  };

  function terminate(entry: ProcessEntry, status: "cancelled" | "timed_out"): Promise<void> {
    if (entry.closed) return Promise.resolve();
    if (entry.terminate) return entry.terminate;
    entry.result.status = status;
    entry.terminate = (async () => {
      const pid = entry.child.pid;
      if (pid) {
        if (
          process.platform === "win32" &&
          entry.child.exitCode === null &&
          entry.child.signalCode === null
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
    })().catch((error) => {
      entry.result.status = "failed";
      const message = `\nCould not confirm process-tree termination: ${error instanceof Error ? error.message : String(error)}`;
      const output = Buffer.concat([entry.buffer, Buffer.from(message)]);
      entry.result.truncated ||= output.length > MAX_OUTPUT;
      entry.buffer = output.subarray(-MAX_OUTPUT);
      entry.child.stdout?.destroy();
      entry.child.stderr?.destroy();
      entry.child.unref();
      entry.finish();
      entry.terminate = undefined;
      throw error;
    });
    return entry.terminate;
  }

  const approval = async ({ input }: ToolPayloadTransformContext) => {
    const args = commandInput.parse(input);
    return { ...args, cwd: await resolveWorkspacePath(root, args.cwd ?? ".") };
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
    description: `Run a non-interactive ${process.platform === "win32" ? "cmd.exe" : "POSIX shell"} command. Explain its purpose in reason. Use background: true for a long-running process, then get_process/kill_process with the returned handle. cwd is not an OS sandbox.`,
    inputSchema: commandInput,
    outputSchema: commandResultSchema,
    transform: { display: transform, transcript: transform },
    execute: async (input, context) => {
      if (disposed) throw new Error("Cube command runtime is closed.");
      context.abortSignal?.throwIfAborted();
      const cwd = await resolveWorkspacePath(root, input.cwd ?? ".");
      if (!(await stat(cwd)).isDirectory()) throw new Error("Command cwd must be a directory.");
      if (disposed) throw new Error("Cube command runtime is closed.");
      if ([...processes.values()].filter((p) => !p.closed).length >= 32)
        throw new Error("32 processes are already active; stop one before starting another.");
      const id = randomUUID();
      const result: CommandResult = {
        kind: "command",
        command: input.command,
        reason: input.reason,
        cwd,
        process_id: id,
        status: "running",
        output: "",
        exit_code: null,
        truncated: false,
      };
      let finish!: () => void;
      const completion = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const windows = process.platform === "win32";
      const child = spawn(input.command, {
        cwd,
        shell: windows ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
        windowsHide: true,
        detached: !windows,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const entry: ProcessEntry = {
        child,
        result,
        buffer: Buffer.alloc(0),
        closed: false,
        completion,
        finish,
      };
      processes.set(id, entry);
      const append = (chunk: Buffer) => {
        if (chunk.length + entry.buffer.length > MAX_OUTPUT) result.truncated = true;
        entry.buffer = Buffer.concat([entry.buffer, chunk]).subarray(-MAX_OUTPUT);
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.once("error", (error) => {
        result.status = "failed";
        append(Buffer.from(error.message));
      });
      child.once("close", (code) => {
        entry.closed = true;
        const completed = [...processes.entries()].filter(([, p]) => p.closed);
        for (const [id] of completed.slice(0, Math.max(0, completed.length - 100)))
          processes.delete(id);
        result.exit_code = code;
        if (result.status === "running") result.status = code === 0 ? "completed" : "failed";
        clearTimeout(timer);
        context.abortSignal?.removeEventListener("abort", cancel);
        finish();
      });
      const stop = (status: "cancelled" | "timed_out") => {
        void terminate(entry, status).catch(() => undefined); // Failure is retained in the process result.
      };
      const timer = setTimeout(() => stop("timed_out"), input.timeout * 1000);
      timer.unref();
      const cancel = () => stop("cancelled");
      context.abortSignal?.addEventListener("abort", cancel, { once: true });
      if (context.abortSignal?.aborted) cancel();
      try {
        if (input.background) {
          await new Promise<void>((done) => {
            child.once("spawn", done);
            child.once("error", () => done());
          });
          return view(entry, input.tail);
        }
        await completion;
        return view(entry, input.tail);
      } finally {
        // A completed tool call must not cancel an intentionally backgrounded process.
        context.abortSignal?.removeEventListener("abort", cancel);
      }
    },
  });
  const get_process = createTool({
    id: "get_process",
    description: "Get bounded output and status of a process started by this Cube runtime.",
    inputSchema: processInput,
    outputSchema: commandResultSchema,
    execute: async ({ process_id, tail }) => view(find(process_id), tail),
  });
  const kill_process = createTool({
    id: "kill_process",
    description:
      "Stop an owned process tree using its Cube process handle, never an arbitrary operating-system PID.",
    inputSchema: processInput,
    outputSchema: commandResultSchema,
    execute: async ({ process_id, tail }) => {
      const entry = find(process_id);
      await terminate(entry, "cancelled");
      return view(entry, tail);
    },
  });
  return {
    tools: { execute_command, get_process, kill_process },
    dispose: () => {
      disposed = true;
      disposal ??= (async () => {
        const outcomes = await Promise.allSettled(
          [...processes.values()].map((entry) => terminate(entry, "cancelled")),
        );
        const failed = outcomes.find((outcome) => outcome.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        processes.clear();
      })();
      return disposal;
    },
  };
}
