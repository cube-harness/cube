---
name: cube-background
description: "Use when running asynchronous builds, tests, servers or other long-running commands in Cube."
---

# Cube Background Work

Use foreground execution for short commands whose output is needed immediately.
Use `execute_command` with background enabled for independent long work or a
server that must stay running, within the same scope and permission rules.
For a server without a deadline, use background: true with timeout: null.
Processes belong to this Cube runtime; /exit stops them.

Retain the returned `process_id` for `manage_task`. Starting a process is not
proof that a build passed or a server is ready. Do useful independent work while
completion/failure arrives through Cube's automatic signal; do not repeatedly
poll merely to wait.
When no independent work remains, report the pending work and end the response;
Cube will deliver the completion later. Do not use sleep commands to keep waiting.

For example, start a requested dev server in the background, inspect its output
when readiness matters, and report the actual readiness evidence. A server still
running is not a failed task simply because it has no exit code.

Use `manage_task` to inspect requested progress/output or stop a process that is
no longer needed. Without cursor it returns a bounded recent preview. When
read_more is present, get that process ID with cursor: 0 to read preserved
output from the beginning, then use next_cursor for needed pages. A page is
at most 16 KiB; limit controls lines, up to 2000. Running EOF is not completion.
Foreground command output can also be read this way, but list remains
background-only. Logs are unavailable after the owning runtime exits.
Do not rerun a mutating command merely because its output was truncated.
Do not confuse a delegated subagent UUID with a command process ID: delegated
jobs use `manage_subagent` instead.

On completion, check the exit status and relevant output before claiming success.
Report real errors and limitations. Cancellation is not successful completion;
do not restart work or widen the task without authorization.
