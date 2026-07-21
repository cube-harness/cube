import { createLogger } from "@/config/logger.js";
import type { StructuredToolInterface } from "@langchain/core/tools";

const log = createLogger("guardrail.tool");
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
