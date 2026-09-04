import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const askUserOptionSchema = z.object({
  label: z.string().min(1).describe("Short display text for this option."),
  description: z.string().optional().describe("Explanation shown beside the option."),
});

const askUserPayloadSchema = z.object({
  question: z.string().min(1),
  options: z.array(askUserOptionSchema).min(1).optional(),
  multiple: z.boolean().optional(),
});

const askUserAnswerSchema = z.union([z.string(), z.array(z.string())]);

const formatAnswer = (answer: z.infer<typeof askUserAnswerSchema>): string =>
  Array.isArray(answer) ? answer.join(", ") : answer;

export const cubeAskUserTool = createTool({
  id: "ask_user",
  description:
    "Ask the user a question and wait for their response. Options are optional suggestions, never restrictions: the user can always enter a custom answer. Set multiple to true when the user may combine several options and custom answers.",
  inputSchema: askUserPayloadSchema,
  suspendSchema: askUserPayloadSchema,
  resumeSchema: askUserAnswerSchema,
  execute: async ({ question, options, multiple }, context) => {
    try {
      const resumeData = context?.agent?.resumeData;
      if (resumeData !== undefined) {
        return {
          content: `User answered: ${formatAnswer(resumeData)}`,
          isError: false,
        };
      }

      const suspend = context?.agent?.suspend;
      if (suspend) {
        await suspend({
          question,
          options,
          multiple: options?.length ? (multiple ?? false) : false,
        });
        return;
      }

      return {
        content: [
          `[Question for user]: ${question}`,
          options?.length
            ? `Suggested options: ${options.map((option) => option.label).join(", ")}`
            : "",
          "The user may enter a custom answer.",
          options?.length && multiple ? "Multiple answers are allowed." : "",
        ]
          .filter(Boolean)
          .join("\n"),
        isError: false,
      };
    } catch (error) {
      return {
        content: `Failed to ask user: ${error instanceof Error ? error.message : "Unknown error"}`,
        isError: true,
      };
    }
  },
});
