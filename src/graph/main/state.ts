import { MessagesValue, StateSchema } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import * as z from "zod";

export const MainState = new StateSchema({
  messages: MessagesValue,
  summary: z.string().default("").optional(),
  summarizedThroughMessageId: z.string().optional(),
  pendingSummaryMessages: z.custom<BaseMessage[]>().optional(),
  pendingSummaryThroughMessageId: z.string().optional(),
});

export type MainStateType = typeof MainState.State;
export type MainStateUpdate = typeof MainState.Update;
