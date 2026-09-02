import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Session } from "../cube-agent/src/index.js";
import { Home } from "../cube-workspace/src/home.js";
import {
  executeSlashCommand,
  type SlashCommandContext,
} from "../cube-runtime/src/slash-commands.js";
import { PromptService } from "../cube-runtime/src/services/prompt.service.js";
import type { ThreadService } from "../cube-runtime/src/services/thread.service.js";
import { MessageList } from "../cube-tui/src/components/message-list.js";

type Sample = {
  medianMs: number;
  p95Ms: number;
  iterations: number;
};

const measure = async (
  operation: () => void | Promise<void>,
  options: { warmup: number; iterations: number },
): Promise<Sample> => {
  for (let index = 0; index < options.warmup; index += 1) {
    await operation();
  }

  const samples: number[] = [];
  for (let index = 0; index < options.iterations; index += 1) {
    const startedAt = performance.now();
    await operation();
    samples.push(performance.now() - startedAt);
  }

  samples.sort((left, right) => left - right);
  const percentile = (value: number): number =>
    samples[Math.min(samples.length - 1, Math.ceil(samples.length * value) - 1)] ?? 0;

  return {
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    iterations: options.iterations,
  };
};

const printSample = (name: string, sample: Sample): void => {
  process.stdout.write(
    `${name}: median=${sample.medianMs.toFixed(3)}ms p95=${sample.p95Ms.toFixed(3)}ms n=${sample.iterations}\n`,
  );
};

const createSyntheticList = (): MessageList => {
  const list = new MessageList();
  for (let index = 0; index < 40; index += 1) {
    list.addMessage({
      id: `message-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Synthetic benchmark message ${index + 1}`,
      status: "done",
    });
  }
  for (let index = 0; index < 10; index += 1) {
    list.upsertTool({
      id: `tool-${index}`,
      name: "mastra_workspace_execute_command",
      args: { command: `Write-Output ${index}` },
      status: "completed",
      result:
        index === 9
          ? Array.from({ length: 120 }, (_, line) => `line ${line + 1}`).join("\n")
          : `result ${index}`,
    });
  }
  return list;
};

const main = async (): Promise<void> => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cube-internal-bench-"));
  const home = new Home({ cubeHome: tempDirectory });
  await home.ensure();

  try {
    const session = {
      followUp: async () => undefined,
    } as unknown as Session;
    const thread = {
      current: () => "benchmark-thread",
      ensureForPrompt: async () => "benchmark-thread",
    } as unknown as ThreadService;
    const commandContext = {} as SlashCommandContext;
    const promptService = new PromptService(
      home,
      session,
      thread,
      commandContext,
      (callback) => callback(),
      async () => undefined,
    );

    const reconcileList = new MessageList();
    const displayState = {
      currentMessage: {
        id: "assistant-benchmark",
        role: "assistant",
        content: {
          parts: [{ type: "text", text: "Synthetic cumulative streaming response" }],
        },
      },
      isRunning: true,
      activeTools: new Map(),
      pendingApproval: null,
    };
    const renderList = createSyntheticList();

    printSample(
      "submit",
      await measure(() => promptService.submit("benchmark prompt"), {
        warmup: 50,
        iterations: 500,
      }),
    );
    printSample(
      "command",
      await measure(() => executeSlashCommand("/exit", "", commandContext), {
        warmup: 50,
        iterations: 500,
      }),
    );
    printSample(
      "reconcile",
      await measure(() =>
        reconcileList.applySessionMessage(
          displayState.currentMessage,
          displayState.isRunning,
        ), {
        warmup: 50,
        iterations: 500,
      }),
    );
    printSample(
      "render",
      await measure(() => {
        renderList.invalidate();
        renderList.render(120);
      }, {
        warmup: 20,
        iterations: 100,
      }),
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};

await main();
