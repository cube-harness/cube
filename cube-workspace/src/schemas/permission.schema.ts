import { z } from "zod";
import { DEFAULT_WORKSPACE_ONLY } from "../constants.js";

export const PermissionsSchema = z
  .object({
    workspace_only: z.boolean().default(DEFAULT_WORKSPACE_ONLY),
    require_approval_for: z.array(z.string().min(1)).default([
      "execute_command", "edit_file", "write_file", "apply_patch",
    ]),
    deny_for: z.array(z.string().min(1)).default([]),
  })
  .strict();

const WorkspacePermissionSchema = z
  .object({
    path: z.string().min(1),
    trusted: z.boolean(),
    permissions: z.object({
      workspace_only: PermissionsSchema.shape.workspace_only.removeDefault().optional(),
      require_approval_for: PermissionsSchema.shape.require_approval_for.removeDefault().optional(),
      deny_for: PermissionsSchema.shape.deny_for.removeDefault().optional(),
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
