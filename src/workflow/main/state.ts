import { StateSchema, MessagesValue } from "@langchain/langgraph";
import * as z from "zod";

export const MainState = new StateSchema({
  messages: MessagesValue,
  summary: z.string().optional(),
});

export type MainStateType = typeof MainState.State;
export type MainStateUpdate = typeof MainState.Update;
