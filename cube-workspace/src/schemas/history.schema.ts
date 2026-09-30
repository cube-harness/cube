import { z } from "zod";

export const HistoryEntrySchema = z
  .object({
    text: z.string().min(1),
    timestamp: z.number().int().nonnegative(),
    threadId: z.string().optional(),
  })
  .strict();

export const HistorySchema = z.array(HistoryEntrySchema);

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type History = z.infer<typeof HistorySchema>;
