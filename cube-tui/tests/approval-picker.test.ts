import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalPicker,
  extractCommandPrefix,
} from "../src/components/approval-picker.js";

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
