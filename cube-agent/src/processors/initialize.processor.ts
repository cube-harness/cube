import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Processor,
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
} from "@mastra/core/processors";

let cachedPrompt: string | null = null;

export const loadInitializePrompt = (): string => {
  if (cachedPrompt) return cachedPrompt;

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    path.join(currentDir, "..", "prompts", "initialize.md"),
    path.join(currentDir, "..", "src", "prompts", "initialize.md"),
    path.resolve(process.cwd(), "cube-agent/src/prompts/initialize.md"),
    path.resolve(process.cwd(), "src/prompts/initialize.md"),
  ];

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      cachedPrompt = readFileSync(candidate, "utf-8").trim();
      return cachedPrompt;
    }
  }

  throw new Error("Could not locate initialize.md prompt file.");
};

export interface InitializeProcessorOptions {
  prompt?: string;
}

export const createInitializeProcessor = (
  options: InitializeProcessorOptions = {},
): Processor => {
  return {
    id: "initialize-processor",
    name: "Initialize Processor",
    description:
      "Injects AGENTS.md initialization prompt during /init command execution without persisting raw prompt to DB",

    async processLLMRequest(
      args: ProcessLLMRequestArgs,
    ): Promise<ProcessLLMRequestResult> {
      const isInit =
        args.requestContext?.get("command") === "init" ||
        (args.requestContext as any)?.all?.command === "init";
      if (!isInit) return;

      const promptText = options.prompt ?? loadInitializePrompt();
      const prompt = args.prompt;

      let lastUserIdx = -1;
      for (let i = prompt.length - 1; i >= 0; i--) {
        if (prompt[i]?.role === "user") {
          lastUserIdx = i;
          break;
        }
      }

      if (lastUserIdx === -1) {
        return {
          prompt: [
            ...prompt,
            {
              role: "user",
              content: [{ type: "text" as const, text: promptText }],
            },
          ],
        };
      }

      const updatedPrompt = prompt.map((msg, idx) => {
        if (idx === lastUserIdx && msg.role === "user") {
          return {
            ...msg,
            content: [{ type: "text" as const, text: promptText }],
          };
        }
        return msg;
      });

      return { prompt: updatedPrompt };
    },
  };
};

export const initializeProcessor: Processor = createInitializeProcessor();
export default initializeProcessor;
