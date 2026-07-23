import { ContextType, MainContext } from "@/workflow/main/context.js";

export const validateContext = (context: unknown): ContextType => {
  const result = MainContext.safeParse(context);
  if (!result.success) {
    throw new Error(`Invalid runtime context — check gateway is passing full context: ${result.error.message}`);
  }
  return result.data;
};

interface RuntimeContextSource {
  context?: unknown;
  configurable?: {
    userId?: unknown;
    agentId?: unknown;
    timeZone?: unknown;
    locale?: unknown;
  };
}

export const resolveRuntimeContext = (source: RuntimeContextSource): ContextType => {
  const context = source.context ?? {
    userId: source.configurable?.userId,
    agentId: source.configurable?.agentId,
    timeZone: source.configurable?.timeZone,
    locale: source.configurable?.locale,
  };

  return validateContext(context);
};
