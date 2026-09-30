// schemas/workspace.schema.ts
import { z } from "zod";

const WorkspaceEntrySchema = z
  .object({
    path: z.string().min(1),
    trustedAt: z.string(),
  })
  .strict();

export const WorkspaceRegistrySchema = z
  .object({
    workspaces: z.array(WorkspaceEntrySchema),
  })
  .strict();

export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;
export type WorkspaceRegistry = z.infer<typeof WorkspaceRegistrySchema>;
