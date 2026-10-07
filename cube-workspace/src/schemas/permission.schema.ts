import { z } from "zod";
import { DEFAULT_WORKSPACE_ONLY } from "../constants.js";

export const PermissionsSchema = z
  .object({
    workspace_only: z.boolean().default(DEFAULT_WORKSPACE_ONLY),
    require_approval_for: z.array(z.string().min(1)).default([
      "execute_command", "edit_file", "write_file", "apply_patch",
    ]),
    deny_for: z.array(z.string().min(1)).default([]),
    allow_for: z.array(z.string().min(1)).default([]),
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
      allow_for: PermissionsSchema.shape.allow_for.removeDefault().optional(),
    }).strict().default({}),
  })
  .strict();

export const PermissionRegistrySchema = z
  .object({
    workspaces: z.array(WorkspacePermissionSchema),
  })
  .strict();

export type WorkspacePermission = z.infer<typeof WorkspacePermissionSchema>;
export type Permissions = z.infer<typeof PermissionsSchema>;
export const resolveToolPermission = (
  name: string,
  permissions: Pick<Permissions, "require_approval_for"> & Partial<Pick<Permissions, "deny_for" | "allow_for">>,
): "ask" | "allow" | "deny" => {
  if (permissions.deny_for?.includes(name)) return "deny";
  if (permissions.require_approval_for.includes(name)) return "ask";
  if (permissions.allow_for?.includes(name)) return "allow";
  return name.startsWith("mcp_") ? "ask" : "allow";
};
export type PermissionRegistry = z.infer<typeof PermissionRegistrySchema>;
