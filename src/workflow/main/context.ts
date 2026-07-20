import { userInfo } from "node:os"
import * as z from "zod"

export const MainContext = z.object({
    userId: z.string().default('dev-user'),
    timeZone: z.string().default('Asia/Ho_Chi_Minh').optional(),
    locale: z.string().default("vi-VN").optional()
})

export type ContextType = z.infer<typeof MainContext>;