import { ContextType, MainContext} from "@/workflow/main/context.js";

export const validateContext = (context: unknown): ContextType => {
  const result = MainContext.safeParse(context);
  if (!result.success) {
    throw new Error(`Invalid runtime context — check gateway is passing full context: ${result.error.message}`);
  }
  return result.data;
};