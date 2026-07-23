import { createLogger } from "@/config/logger.js";
import { resolveRuntimeContext } from "@/guardrail/context.guardrail.js";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";

const log = createLogger("guardrail.tool");


export interface ToolRuntimeGuardrailSource {
  configurable?: {
    thread_id?: string;
    run_id?: string;
    userId?: unknown;
    agentId?: unknown;
    timeZone?: unknown;
    locale?: unknown;
  };
  context?: unknown;
}

type RuntimeGuardrail = (
  input: unknown,
  runtime: ToolRuntimeGuardrailSource,
  toolName: string,
) => void | Promise<void>;

interface ToolGroup {
  name: string;
  tools: StructuredToolInterface[];
  isEnabled: () => boolean;
}
export const resolveTools = (
  groups: ToolGroup[],
): StructuredToolInterface[] => {
  const enabled: StructuredToolInterface[] = [];
  for (const group of groups) {
    if (group.isEnabled()) {
      enabled.push(...group.tools);
    } else {
      log.warn(
        { group: group.name, toolNames: group.tools.map((t) => t.name) },
        "Tool group disabled — missing config",
      );
    }
  }
  return enabled;
};

// Condition flag
export const requireEnv =
  (...values: Array<string | undefined>) =>
  () =>
    values.every((v) => Boolean(v));

export const alwaysEnabled = () => true;

export const promptToolsEnabled = () => true;

// Enable if ALL conditions are met — use when a tool requires multiple guardrails simultaneously
export const all =
  (...conditions: Array<() => boolean>) =>
  () =>
    conditions.every((cond) => cond());

// Enable if at least one condition is met.
export const any =
  (...conditions: Array<() => boolean>) =>
  () =>
    conditions.some((cond) => cond());

