import type { Agent } from "@mastra/core/agent";
import type { InputProcessor } from "@mastra/core/processors";
import { RequestContext } from "@mastra/core/request-context";

export function createSubagentToolsProcessor(
  readAgents: (context: RequestContext) => Record<string, Agent>,
): InputProcessor {
  return {
    id: "cube-subagent-tools",
    processInputStep: ({ tools, activeTools, requestContext }) => {
      if (!tools) return;
      const names = Object.keys(readAgents(requestContext ?? new RequestContext())).filter(name =>
        Object.hasOwn(tools, `agent-${name}`),
      );
      if (!names.length) return;
      const renamed = { ...tools };
      for (const name of names) delete renamed[`agent-${name}`];
      for (const name of names) {
        if (Object.hasOwn(renamed, name))
          throw new Error(`Subagent tool name conflicts with an existing tool: ${name}. Rename the subagent.`);
        renamed[name] = tools[`agent-${name}`];
      }
      return {
        tools: renamed,
        ...(activeTools ? { activeTools: activeTools.map(name =>
          names.find(role => name === `agent-${role}`) ?? name) } : {}),
      };
    },
  };
}
