import { createSafeToolNode } from "@/middleware/tool_node.middleware.js";
import { systemTools } from "@/shared/tools/index.js";

export const toolNode = createSafeToolNode(systemTools);
