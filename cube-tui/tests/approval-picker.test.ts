import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  ApprovalPicker,
  extractCommandPrefix,
} from "../src/components/approval-picker.js";

test("approval shows the proposed diff, strips terminal controls and refuses failed preparation", () => {
  let decision: string | undefined;
  const picker = new ApprovalPicker({ toolName: "edit_file", args: { preview: {
    kind: "file_changes", status: "proposed", summary: "Proposed", changes: [{
      path: "a.txt", operation: "update", diff: "@@ -1 +1 @@\n-before\n+after\x1b[2J", added: 1, removed: 1, status: "proposed", truncated: false,
    }],
  } }, onDecision: (value) => { decision = value; } });
  const rows = picker.render(30);
  assert.ok(rows.every((row) => visibleWidth(row) <= 30));
  assert.match(rows.join("\n"), /-before/);
  assert.match(rows.join("\n"), /\+after/);
  assert.doesNotMatch(rows.join("\n"), /\x1b\[2J/);
  const failed = new ApprovalPicker({ toolName: "edit_file", args: { preview: {
    kind: "file_changes", status: "failed", summary: "File changed", changes: [],
  } }, onDecision: (value) => { decision = value; } });
  failed.handleInput("y");
  assert.equal(decision, undefined);
  failed.handleInput("\r");
  assert.equal(decision, "decline");
});

test("ApprovalPicker approves the selected tool with Enter", () => {
  let decision: string | undefined;
  const picker = new ApprovalPicker({
    toolName: "mastra_workspace_execute_command",
    args: { command: "git status" },
    onDecision: (value) => {
      decision = value;
    },
  });

  picker.handleInput("\r");
  assert.equal(decision, "approve");
});

test("ApprovalPicker treats Escape as decline", () => {
  let decision: string | undefined;
  const picker = new ApprovalPicker({
    toolName: "mastra_workspace_execute_command",
    args: { command: "git status" },
    onDecision: (value) => {
      decision = value;
    },
  });

  picker.handleInput("\x1b");
  assert.equal(decision, "decline");
});

test("ApprovalPicker handles centralized approve, prefix, and decline shortcuts", () => {
  const decide = (input: string) => {
    let decision: string | undefined;
    const picker = new ApprovalPicker({
      toolName: "mastra_workspace_execute_command",
      args: {
        command:
          "pnpm --filter @cube/agent exec tsx --test --test-isolation=none tests/controller.test.ts",
      },
      onDecision: (value) => {
        decision = value;
      },
    });
    picker.handleInput(input);
    return decision;
  };

  for (const input of ["y", "Y", "1"]) assert.equal(decide(input), "approve");
  for (const input of ["p", "P", "2"])
    assert.equal(decide(input), "approve_prefix");
  for (const input of ["n", "N", "3", "\x1b", "\x03"])
    assert.equal(decide(input), "decline");
});

test("ApprovalPicker renders command, environment, and reason", () => {
  const picker = new ApprovalPicker({
    toolName: "mastra_workspace_execute_command",
    args: {
      command: "Get-Date",
      reason: "Get current system date",
      environment: "local",
    },
    onDecision: () => undefined,
  });
  const rendered = picker.render(80).join("\n");

  assert.match(rendered, /Would you like to run the following command\?/);
  assert.match(rendered, /Environment:\s+local/);
  assert.match(rendered, /Reason:\s+Get current system date/);
  assert.match(rendered, /\$\s+Get-Date/);
});

test("extractCommandPrefix returns the reusable executable prefix", () => {
  assert.equal(
    extractCommandPrefix(
      "pnpm --filter @cube/agent exec tsx --test --test-isolation=none tests/controller.test.ts",
    ),
    "pnpm --filter @cube/agent exec tsx",
  );
  assert.equal(extractCommandPrefix("git status"), "git status");
  assert.equal(extractCommandPrefix("npm run build --flag"), "npm run build");
});
