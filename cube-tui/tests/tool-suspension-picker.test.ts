import assert from "node:assert/strict";
import test from "node:test";
import {
  ToolSuspensionPicker,
  type ToolSuspensionResolution,
} from "../src/components/tool-suspension-picker.js";

test("question suspensions preserve single, multiple, custom answers and cancellation", () => {
  const options = [{ label: "Tests" }, { label: "Docs" }];
  for (const { payload, inputs, expected } of [
    { payload: { options }, inputs: ["\r"], expected: { kind: "resume", resumeData: "Tests" } },
    { payload: { options }, inputs: ["\x1b[B", "\x1b[B", "\r", "Local model", "\r"], expected: { kind: "resume", resumeData: "Local model" } },
    { payload: {}, inputs: ["\r", "notes.md", "\r"], expected: { kind: "resume", resumeData: "notes.md" } },
    { payload: { options, multiple: true }, inputs: [" ", "\x1b[B", "\x1b[B", "Manual review", "\r"], expected: { kind: "resume", resumeData: ["Tests", "Manual review"] } },
    { payload: { options, selectionMode: "multi_select" }, inputs: ["\x1b[B", " ", "\x1b[A", " ", "\r"], expected: { kind: "resume", resumeData: ["Tests", "Docs"] } },
    { payload: { options }, inputs: ["\x1b"], expected: { kind: "cancel" } },
  ]) {
    const resolutions: ToolSuspensionResolution[] = [];
    const picker = new ToolSuspensionPicker({
      request: {
        toolCallId: "question", toolName: "custom_question", args: {},
        suspendPayload: { question: "What next?", ...payload },
      },
      onResolve: resolution => resolutions.push(resolution),
    });
    picker.focused = true;
    for (const input of inputs) picker.handleInput(input);
    assert.deepEqual(resolutions, [expected]);
  }
});

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
