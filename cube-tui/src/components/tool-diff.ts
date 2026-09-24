import { stripTerminalSequences, wrapTextWithAnsi, truncateToWidth } from "@earendil-works/pi-tui";
import type { FileMutationResult, CommandResult } from "@cube/runtime";
import { appTheme } from "../themes/app.theme.js";
import { formatBinding } from "../keybindings.js";

export const toolText = (text: string): string => stripTerminalSequences(text)
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replaceAll("\t", "    ");

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;

export function fileChanges(value: unknown): FileMutationResult | undefined {
  const result = record(value);
  if (result?.kind !== "file_changes" || typeof result.summary !== "string" || !["proposed", "applied", "failed", "partial"].includes(String(result.status)) || !Array.isArray(result.changes)) return;
  if (!result.changes.every((value) => {
    const c = record(value);
    return c && typeof c.path === "string" && typeof c.diff === "string" &&
      ["add", "update", "delete", "move"].includes(String(c.operation)) &&
      ["proposed", "applied", "failed", "not_applied"].includes(String(c.status)) &&
      typeof c.added === "number" && Number.isFinite(c.added) && typeof c.removed === "number" && Number.isFinite(c.removed) &&
      typeof c.truncated === "boolean" && (c.destination === undefined || typeof c.destination === "string") && (c.error === undefined || typeof c.error === "string");
  })) return;
  return value as FileMutationResult;
}

export function commandResult(value: unknown): CommandResult | undefined {
  const result = record(value);
  if (result?.kind !== "command" || !["command", "reason", "cwd", "output", "process_id"].every((key) => typeof result[key] === "string") || !["running", "completed", "failed", "cancelled", "timed_out"].includes(String(result.status)) || !(result.exit_code === null || typeof result.exit_code === "number") || typeof result.truncated !== "boolean") return;
  return value as CommandResult;
}

// Both approval and persisted transcript render the result; never reread the file.
export function renderToolDiff(result: FileMutationResult, width: number, expanded: boolean): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  const push = (text: string, color = appTheme.ui.muted) => {
    for (const line of toolText(text).split(/\r?\n/)) {
      lines.push(...wrapTextWithAnsi(color(line), width).map((row) => truncateToWidth(row, width)));
    }
  };
  if (result.status === "failed" || result.status === "partial" || !result.changes.length) push(result.summary, appTheme.status.error);
  for (const change of result.changes) {
    push(`${change.status} · ${change.operation}: ${change.path}${change.destination ? ` → ${change.destination}` : ""} (+${change.added}/-${change.removed})`, appTheme.ui.text);
    if (change.error) push(change.error, appTheme.status.error);
    const rows = toolText(change.diff).split(/\r?\n/);
    const shown = expanded ? rows : rows.slice(0, 10);
    for (const row of shown) push(row, row.startsWith("+") ? appTheme.status.success : row.startsWith("-") ? appTheme.status.error : appTheme.ui.muted);
    if (shown.length < rows.length) push(`… +${rows.length - shown.length} lines (${formatBinding("cube.transcript.toggle")} to expand)`);
    if (change.truncated) push("Diff truncated", appTheme.status.warning);
  }
  return lines;
}
