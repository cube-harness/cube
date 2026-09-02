import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AskUserPicker } from "../src/components/ask-user-picker.js";

test("AskUserPicker renders the native question and returns a selected option", () => {
  const answers: unknown[] = [];
  const picker = new AskUserPicker({
    payload: {
      question: "Bạn muốn demo tool nào tiếp theo?",
      options: [
        { label: "write_file", description: "Tạo một file mới" },
        { label: "edit_file", description: "Sửa một file" },
      ],
      multiple: false,
    },
    onAnswer: (answer) => answers.push(answer),
    onCancel: () => answers.push(null),
  });

  const rendered = picker.render(100).join("\n");
  assert.match(rendered, /Bạn muốn demo tool nào tiếp theo\?/);
  assert.match(rendered, /write_file/);
  assert.match(rendered, /Tạo một file mới/);
  assert.match(rendered, /Sửa một file/);
  assert.doesNotMatch(rendered, /Nhập câu trả lời khác/);
  assert.match(rendered, />/);
  assert.doesNotMatch(rendered, /Would you like to run the tool/);

  picker.handleInput("\r");
  assert.deepEqual(answers, ["write_file"]);
});

test("AskUserPicker keeps a custom-answer input inline below the options", () => {
  const answers: unknown[] = [];
  const picker = new AskUserPicker({
    payload: {
      question: "Bạn muốn dùng model nào?",
      options: [{ label: "Gemini" }, { label: "Poolside" }],
    },
    onAnswer: (answer) => answers.push(answer),
    onCancel: () => answers.push(null),
  });

  const rendered = picker.render(80).join("\n");
  assert.doesNotMatch(rendered, /\+ Nhập câu trả lời khác/);
  assert.match(rendered, />/);

  picker.handleInput("\u001b[B");
  picker.handleInput("\u001b[B");
  picker.handleInput("Local model");
  picker.handleInput("\r");

  assert.deepEqual(answers, ["Local model"]);
});

test("AskUserPicker lets a single-select question return a custom answer", () => {
  const answers: unknown[] = [];
  const picker = new AskUserPicker({
    payload: {
      question: "Bạn muốn dùng model nào?",
      options: [{ label: "Gemini" }, { label: "Poolside" }],
    },
    onAnswer: (answer) => answers.push(answer),
    onCancel: () => answers.push(null),
  });

  picker.handleInput("\u001b[B");
  picker.handleInput("\u001b[B");
  picker.handleInput("\r");
  picker.handleInput("Local model");
  picker.handleInput("\r");

  assert.deepEqual(answers, ["Local model"]);
});

test("AskUserPicker renders a full-width approval-style card", () => {
  const picker = new AskUserPicker({
    payload: {
      question: "Bạn muốn làm gì?",
      options: [{ label: "Tiếp tục", description: "Tiếp tục công việc" }],
    },
    onAnswer: () => undefined,
    onCancel: () => undefined,
  });

  const lines = picker.render(60);
  assert.equal(lines[0], "");
  assert.equal(lines.at(-1), "");
  assert.equal(lines.slice(1, -1).every((line) => visibleWidth(line) === 60), true);
});

test("AskUserPicker accepts free-text answers", () => {
  const answers: unknown[] = [];
  const picker = new AskUserPicker({
    payload: { question: "Tên file là gì?" },
    onAnswer: (answer) => answers.push(answer),
    onCancel: () => answers.push(null),
  });

  picker.handleInput("notes.md");
  picker.handleInput("\r");

  assert.deepEqual(answers, ["notes.md"]);
});

test("AskUserPicker combines selected options with an inline custom answer", () => {
  const answers: unknown[] = [];
  const picker = new AskUserPicker({
    payload: {
      question: "Chọn các việc cần làm",
      options: [
        { label: "Tests" },
        { label: "Docs" },
      ],
      multiple: true,
    },
    onAnswer: (answer) => answers.push(answer),
    onCancel: () => answers.push(null),
  });

  picker.handleInput(" ");
  picker.handleInput("\u001b[B");
  picker.handleInput("\u001b[B");
  picker.handleInput("Manual review");
  picker.handleInput("\r");

  assert.deepEqual(answers, [["Tests", "Manual review"]]);
});
