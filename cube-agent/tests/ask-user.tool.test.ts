import assert from "node:assert/strict";
import test from "node:test";

const loadCubeAskUserTool = async () => {
  const module = await import("../src/tools/ask-user.tool.js").catch(() => ({}));
  const tool = (module as { cubeAskUserTool?: unknown }).cubeAskUserTool as {
    execute?: (input: unknown, context: unknown) => Promise<unknown>;
  } | undefined;

  assert.equal(typeof tool?.execute, "function", "cubeAskUserTool must exist");
  return tool;
};

test("Cube ask_user suspends with the combined choice and custom-answer contract", async () => {
  const tool = await loadCubeAskUserTool();

  let suspendedPayload: unknown;
  const result = await tool.execute!(
    {
      question: "Bạn muốn làm gì tiếp theo?",
      options: [
        { label: "Tests", description: "Chạy test" },
        { label: "Docs", description: "Viết tài liệu" },
      ],
      multiple: true,
    },
    {
      agent: {
        suspend: async (payload: unknown) => {
          suspendedPayload = payload;
        },
      },
    },
  );

  assert.equal(result, undefined);
  assert.deepEqual(suspendedPayload, {
    question: "Bạn muốn làm gì tiếp theo?",
    options: [
      { label: "Tests", description: "Chạy test" },
      { label: "Docs", description: "Viết tài liệu" },
    ],
    multiple: true,
  });
});

test("Cube ask_user returns option and custom answers together after resume", async () => {
  const tool = await loadCubeAskUserTool();
  const result = await tool.execute!(
    {
      question: "Chọn các việc cần làm",
      options: [{ label: "Tests" }],
      multiple: true,
    },
    {
      agent: {
        resumeData: ["Tests", "Kiểm tra thủ công"],
      },
    } as never,
  );

  assert.deepEqual(result, {
    content: "User answered: Tests, Kiểm tra thủ công",
    isError: false,
  });
});
