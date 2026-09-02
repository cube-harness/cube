import assert from "node:assert/strict";
import test from "node:test";
import {
  ToolSuspensionPicker,
  type ToolSuspensionResolution,
} from "../src/components/tool-suspension-picker.js";

test("ToolSuspensionPicker presents submit_plan and returns native approval data", () => {
  const resolutions: ToolSuspensionResolution[] = [];
  const picker = new ToolSuspensionPicker({
    request: {
      toolCallId: "call-plan",
      toolName: "submit_plan",
      args: { path: ".mastracode/plans/demo-tools-plan.md" },
      suspendPayload: {
        path: ".mastracode/plans/demo-tools-plan.md",
        title: "Demo tools",
        plan: "# Demo tools\n\n- Add picker coverage",
      },
    },
    onResolve: (resolution) => resolutions.push(resolution),
  });

  const rendered = picker.render(100).join("\n");
  assert.match(rendered, /Review implementation plan/);
  assert.match(rendered, /Demo tools/);
  assert.match(rendered, /Add picker coverage/);

  picker.handleInput("\r");
  assert.deepEqual(resolutions, [{
    kind: "resume",
    resumeData: {
      action: "approved",
      path: ".mastracode/plans/demo-tools-plan.md",
      title: "Demo tools",
      plan: "# Demo tools\n\n- Add picker coverage",
    },
  }]);
});

test("ToolSuspensionPicker collects feedback when submit_plan is rejected", () => {
  const resolutions: ToolSuspensionResolution[] = [];
  const picker = new ToolSuspensionPicker({
    request: {
      toolCallId: "call-plan",
      toolName: "submit_plan",
      args: {},
      suspendPayload: { path: "plan.md" },
    },
    onResolve: (resolution) => resolutions.push(resolution),
  });

  picker.handleInput("\u001b[B");
  picker.handleInput("\r");
  picker.handleInput("Add error handling");
  picker.handleInput("\r");

  assert.deepEqual(resolutions, [{
    kind: "resume",
    resumeData: {
      action: "rejected",
      feedback: "Add error handling",
      path: "plan.md",
    },
  }]);
});

test("ToolSuspensionPicker provides a JSON fallback for unknown suspension tools", () => {
  const resolutions: ToolSuspensionResolution[] = [];
  const picker = new ToolSuspensionPicker({
    request: {
      toolCallId: "call-custom",
      toolName: "custom_confirmation",
      args: {},
      suspendPayload: { reason: "Confirm deployment" },
      resumeSchema: '{"type":"object","properties":{"confirmed":{"type":"boolean"}}}',
    },
    onResolve: (resolution) => resolutions.push(resolution),
  });

  const rendered = picker.render(100).join("\n");
  assert.match(rendered, /custom_confirmation/);
  assert.match(rendered, /Confirm deployment/);

  picker.handleInput('{"confirmed":true}');
  picker.handleInput("\r");
  assert.deepEqual(resolutions, [{
    kind: "resume",
    resumeData: { confirmed: true },
  }]);
});
