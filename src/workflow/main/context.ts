import * as z from "zod";

export const MainContext = z.object({
  userId: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  timeZone: z.string().trim().min(1),
  locale: z.string().trim().min(1),
});

export type ContextType = z.infer<typeof MainContext>;
