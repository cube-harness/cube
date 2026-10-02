import { z } from "zod";
import { PermissionsSchema } from "./config.schema.js";

const WorkspacePermissionSchema = z
  .object({
    path: z.string().min(1),
    trusted: z.boolean(),
    permissions: z.object({
      workspace_only: PermissionsSchema.shape.workspace_only.removeDefault().optional(),
      require_approval_for: PermissionsSchema.shape.require_approval_for.removeDefault().optional(),
    }).strict().default({}),
  })
  .strict();

export const PermissionRegistrySchema = z
  .object({
    workspaces: z.array(WorkspacePermissionSchema),
  })
  .strict();

export type WorkspacePermission = z.infer<typeof WorkspacePermissionSchema>;
export type PermissionRegistry = z.infer<typeof PermissionRegistrySchema>;
