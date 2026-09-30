import { basename, extname } from "node:path";
import { stripTerminalSequences, wrapTextWithAnsi, truncateToWidth } from "@earendil-works/pi-tui";
import type { FileMutationResult, CommandResult } from "@cube/runtime";
import { appTheme } from "../themes/app.theme.js";
import { formatBinding } from "../keybindings.js";
import { createHighlightCode } from "../themes/code-highlight.js";
import { getSyntaxTheme } from "../themes/syntax.theme.js";

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

// Render the supplied preview/result in the transcript; never reread the file.
export function renderToolDiff(
  result: FileMutationResult,
  width: number,
  expanded: boolean,
  indent = 0,
): string[] {
  if (width <= 0) return [];
  const padding = " ".repeat(Math.min(indent, Math.max(0, width - 1)));
  const contentWidth = width - padding.length;
  const syntax = getSyntaxTheme();
  const highlight = createHighlightCode(syntax);
  const lines: string[] = [];
  const push = (text: string, color = appTheme.ui.muted) => {
    for (const line of toolText(text).split(/\r?\n/)) {
      lines.push(
        ...wrapTextWithAnsi(color(line), contentWidth).map((row) =>
          truncateToWidth(padding + row, width),
        ),
      );
    }
  };
  if (result.status === "failed" || result.status === "partial" || !result.changes.length) push(result.summary, appTheme.status.error);
  for (const change of result.changes) {
    const description = toolText(`${change.status} · ${change.operation}: ${change.path}${change.destination ? ` → ${change.destination}` : ""}`);
    const header = appTheme.ui.muted(`${description} (${appTheme.status.success(`+${change.added}`)}/${appTheme.status.error(`-${change.removed}`)})`);
    lines.push(
      ...wrapTextWithAnsi(header, contentWidth).map((row) =>
        truncateToWidth(padding + row, width),
      ),
    );
    if (change.error) push(change.error, appTheme.status.error);
    const diffRows = toolText(change.diff).replace(/\r?\n$/, "").split(/\r?\n/);
    const hunkStart = diffRows.findIndex((row) => row.startsWith("@@"));
    const rows = hunkStart < 0 ? [] : diffRows.slice(hunkStart);
    let inHunk = false;
    const codeRows = rows.map((row) => {
      if (row.startsWith("@@")) inHunk = true;
      return inHunk && /^[ +\-]/.test(row) ? row : undefined;
    });
    const filename = basename(change.destination ?? change.path).toLowerCase();
    const language = extname(filename).slice(1) || filename;
    // Keep old/new code separate so a removed string/comment cannot recolor the addition.
    const before = highlight(
      codeRows.map((row) => row && row[0] !== "+" ? row.slice(1) : "").join("\n"),
      language,
    );
    const after = highlight(
      codeRows.map((row) => row && row[0] !== "-" ? row.slice(1) : "").join("\n"),
      language,
    );
    const shown = expanded ? rows : rows.slice(0, 10);
    shown.forEach((row, index) => {
      const code = codeRows[index];
      const styled = code === undefined
        ? appTheme.ui.muted(row)
        : syntax.tokens.variable(row[0] + ((row[0] === "-" ? before : after)[index] ?? row.slice(1)));
      const background = code?.startsWith("+")
        ? syntax.tokens.diffAddedBg
        : code?.startsWith("-") ? syntax.tokens.diffRemovedBg : undefined;
      for (const wrapped of wrapTextWithAnsi(styled, contentWidth)) {
        const line = truncateToWidth(padding + wrapped, width, "", Boolean(background));
        lines.push(background ? background(line) : line);
      }
    });
    if (shown.length < rows.length) push(`… +${rows.length - shown.length} lines (${formatBinding("cube.transcript.toggle")} to expand)`);
    if (change.truncated) push("Diff truncated", appTheme.status.warning);
  }
  return lines;
}
