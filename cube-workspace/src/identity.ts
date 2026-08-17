import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

export interface WorkspaceIdentity {
  canonicalPath: string;
  resourceId: string;
}

export const canonicalizeWorkspacePath = (workspacePath: string): string =>
  realpathSync.native(path.resolve(workspacePath));

export const workspaceComparisonKey = (
  workspacePath: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  const normalized = path.normalize(workspacePath);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
};

export const createWorkspaceResourceId = (
  canonicalPath: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  const identityPath = workspaceComparisonKey(canonicalPath, platform);
  return `workspace:${createHash("sha256").update(identityPath, "utf8").digest("hex")}`;
};

export const resolveWorkspaceIdentity = (
  workspacePath: string,
): WorkspaceIdentity => {
  const canonicalPath = canonicalizeWorkspacePath(workspacePath);
  return {
    canonicalPath,
    resourceId: createWorkspaceResourceId(canonicalPath),
  };
};

