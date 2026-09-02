import {
  taskCheckTool,
  taskCompleteTool,
  taskUpdateTool,
  taskWriteTool,
} from "@mastra/core/tools";
import { MCPServer } from "@mastra/mcp";
import { cubeAskUserTool } from "../tools/ask-user.tool.js";

export const createMcpServer = (): MCPServer =>
  new MCPServer({
    name: "My Server",
    version: "1.0.0",
    description: "A server that provides weather data and agent capabilities",
    instructions:
      "Use the available tools to help users with weather information and data processing tasks.",
    tools: {
      ask_user: cubeAskUserTool,
      taskWriteTool,
      taskCheckTool,
      taskCompleteTool,
      taskUpdateTool,
    },
  });
