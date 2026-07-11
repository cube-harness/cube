import * as z from "zod";

export const MainContext = z.object({
    userId: z.string().default("dev"),
    userRole: z.string().default("admin"),
    userMemory: z.string().optional(),
    timeZone: z.string().default("Asia/Ho_Chi_Minh"),
    locale: z.string().default("vi-VN")
})

export type ContextType = z.infer<typeof MainContext>;