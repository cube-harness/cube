import { PermissionsSchema, resolveToolPermission, type CubeConfig, type WorkspaceManager } from "@cube/workspace";
import type { PermissionState } from "../types.js";

export class PermissionService {
  private applying = false;

  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly current: CubeConfig["permissions"],
    private readonly options: {
      listTools(): Promise<string[]>;
      isBusy(): boolean;
      apply(permissions: CubeConfig["permissions"]): Promise<void>;
    },
  ) {}

  isApplying(): boolean {
    return this.applying;
  }

  async get(): Promise<PermissionState> {
    const names = new Set([
      ...await this.options.listTools(),
      ...this.current.require_approval_for,
      ...this.current.deny_for,
      ...(this.current.allow_for ?? []),
    ]);
    return {
      workspaceOnly: this.current.workspace_only,
      tools: Object.fromEntries([...names].sort().map((name) => [name,
        resolveToolPermission(name, this.current),
      ])),
    };
  }

  async set(state: PermissionState): Promise<void> {
    if (this.applying || this.options.isBusy())
      throw new Error("Finish or cancel the current turn before changing permissions.");
    this.applying = true;
    const previous = structuredClone(this.current);
    let saved = false;
    let disk: CubeConfig["permissions"] | undefined;
    try {
      const available = await this.get();
      const entries = Object.entries(state.tools);
      if (Object.keys(available.tools).length !== entries.length || entries.some(([name, policy]) =>
        !Object.hasOwn(available.tools, name) || !["ask", "allow", "deny"].includes(policy)))
        throw new Error("Tools have changed. Reopen /permissions.");
      const next = PermissionsSchema.parse({
        workspace_only: state.workspaceOnly,
        require_approval_for: entries.filter(([, policy]) => policy === "ask").map(([name]) => name),
        deny_for: entries.filter(([, policy]) => policy === "deny").map(([name]) => name),
        allow_for: entries.filter(([, policy]) => policy === "allow").map(([name]) => name),
      });
      const entry = await this.workspace.getPermission();
      if (!entry?.trusted) throw new Error("Workspace is not trusted.");
      disk = PermissionsSchema.parse(entry.permissions);
      if (this.options.isBusy()) throw new Error("Finish or cancel the current turn before changing permissions.");
      await this.workspace.setPermissions(next);
      saved = true;
      const reloaded = await this.workspace.getPermission();
      if (!reloaded?.trusted) throw new Error("Workspace is not trusted.");
      await this.options.apply(PermissionsSchema.parse(reloaded.permissions));
    } catch (error) {
      if (saved) {
        // Restore both sources if live application failed; surface rollback failures too.
        const rollback = await Promise.allSettled([
          this.workspace.setPermissions(disk!), this.options.apply(previous),
        ]);
        const failures = rollback.filter((result) => result.status === "rejected");
        if (failures.length) throw new AggregateError(
          [error, ...failures.map((result) => result.reason)],
          "Permission change and rollback failed. Check this workspace's permission.json entry.",
        );
      }
      throw error;
    } finally {
      this.applying = false;
    }
  }
}
