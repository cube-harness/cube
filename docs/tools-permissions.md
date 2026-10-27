# Tools & Permissions

Understand what a tool can do, what needs approval, and what workspace trust protects.

<a id="file-tools"></a>

## File Tools & Diffs

Cube exposes read_file and list_files alongside write_file, edit_file and a Codex-format apply_patch for compatible models. File edits produce diffs in the message list, not in the approval picker. Use Ctrl+T to expand long tool output.

Targeted editing checks the expected old content; ambiguous matches and stale previews should fail rather than overwrite a file based on outdated content. A proposed edit is not an applied change until the tool completes successfully.

Search is performed through execute_command using rg. Installed releases bundle ripgrep for supported platforms; development uses the host PATH. Cube does not expose a separate grep tool. read_file can return binary media for PDFs/images; provider support and token cost differ from ordinary UTF-8 text.

<a id="commands"></a>

## Command Execution

execute_command includes a reason and cwd. Windows commands use PowerShell 5.1 with no profile and non-interactive mode, even if you launched Cube from cmd.exe. Use pnpm.cmd/npm.cmd rather than PowerShell script shims when needed. macOS/Linux commands use POSIX /bin/sh.

Commands have no interactive TTY: avoid editors, password prompts, pagers and confirmation questions. A foreground command waits for its result; background:true is explicit. Processes run on your host with your account's OS access, not in an isolated OS sandbox.

<a id="trust"></a>

## Workspace Trust & Boundaries

On the first visit to a workspace, trust permits Cube to operate there and stores a record in ~/.cube/permission.json. It does not remove approvals. Decline/cancel exits without recording a rejection.

workspace_only defaults to true. Cube validates file paths and command cwd against the workspace; a path outside the permitted boundary is denied directly, rather than presented as an approval that cannot succeed.

Command cwd validation does not inspect every shell instruction. A command starting inside the workspace can still reference an absolute outside path, change directory, access the network, or delete files. Keep command approvals enabled for untrusted work and inspect both reason and arguments. This boundary is not an OS sandbox.

<a id="policy"></a>

## Ask, Allow & Deny

Use /permissions to select Ask, Allow or Deny for each tool and Enable/Disable for workspace_only. Applying the picker updates the current workspace policy without restarting. Deny takes precedence over Ask, then Allow; MCP tools default to Ask. Cube's default approval list contains execute_command, edit_file, write_file and apply_patch.

Use y to approve, n to decline, or the p command-prefix remember option when shown. Approval cannot override an invalid file boundary. Disabling workspace_only permits supported outside paths/cwd but does not disable the tool policy.

Permissions belong in permission.json, not config.yaml. The example below illustrates one workspace; preserve other workspace records when editing it manually.

**permission.json · example workspace record**

```json
{
  "workspaces": [{
    "path": "D:/Projects/my-app",
    "trusted": true,
    "permissions": {
      "workspace_only": true,
      "require_approval_for": ["execute_command", "edit_file", "write_file", "apply_patch"],
      "allow_for": [],
      "deny_for": []
    }
  }]
}
```
