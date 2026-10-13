import { COMMAND_SHELL } from "../tools/command.tools.js";

export function buildExecutionInstructions(root: string, workspaceOnly: boolean): string {
  return [
    `OS: ${process.platform}. Working directory: ${root}. execute_command uses ${COMMAND_SHELL}.`,
    process.platform === "win32"
      ? "Use Windows PowerShell 5.1 syntax: Get-ChildItem, Get-Content, $env:VAR, and & for quoted executable paths. Do not use cmd %VAR% syntax or &&. Invoke pnpm.cmd/npm.cmd rather than their .ps1 shims; do not bypass execution policy."
      : "Use POSIX /bin/sh syntax, not PowerShell or bash-only features.",
    `Command cwd ${workspaceOnly ? "is restricted to the workspace root" : "may be outside the workspace root"}; omitted cwd defaults to the root. Commands run on the host and are NOT an OS sandbox.`,
    "Commands have no TTY and no interactive profile. Avoid prompts, editors and pagers. Supply a brief reason for each command.",
  ].join("\n");
}
