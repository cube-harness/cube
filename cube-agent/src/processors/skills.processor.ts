import { isUserAuthoredMessage, type MessageList } from "@mastra/core/agent";
import type { InputProcessor } from "@mastra/core/processors";
import { RequestContext } from "@mastra/core/request-context";
import type { CubeSkills } from "../skills.js";
import { formatActivatedSkill } from "../prompts/skills.prompt.js";

export function findSkillMentions(text: string, knownNames: ReadonlySet<string>): string[] {
  // Exclude fenced and inline code before matching literal catalog names.
  const prose = text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*(?:\n|$)|$(?![\s\S]))/gm, " ")
    .replace(/(`+)[\s\S]*?\1(?!`)/g, " ");
  return [...new Set([...prose.matchAll(/(?:^|[\s([{])\$([a-zA-Z0-9][a-zA-Z0-9_-]*)(?![a-zA-Z0-9_-])/g)]
    .map((match) => match[1]!).filter((name) => knownNames.has(name)))];
}

export function createSkillsProcessor(skills: CubeSkills): InputProcessor {
  async function enrich(messageList: MessageList, requestContext?: RequestContext) {
    const inputs = messageList.get.input.db().filter(isUserAuthoredMessage);
    if (!inputs.length) return messageList;
    const snapshot = await skills.snapshot(requestContext ?? new RequestContext());
    const names = new Set(snapshot.catalog.map((skill) => skill.name));
    for (const message of inputs) {
      const metadata = message.content.metadata ?? {};
      const cube = (metadata.cube ?? {}) as Record<string, unknown>;
      if (typeof cube.displayText === "string") continue;
      const text = message.content.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const mentions = findSkillMentions(text, names);
      if (!mentions.length) continue;
      const blocks = [];
      for (const name of mentions) {
        if (!snapshot.catalog.some((skill) => skill.name === name && skill.enabled)) {
          throw new Error(`Skill "${name}" is disabled. Enable it with /skills.`);
        }
        const skill = await snapshot.enabled.get(name);
        if (!skill) throw new Error(`Cannot load skill "${name}". Check /skills.`);
        blocks.push({ type: "text" as const, text: formatActivatedSkill(skill) });
      }
      messageList.add({ ...message, content: { ...message.content,
        parts: [...blocks, ...message.content.parts],
        metadata: { ...metadata, cube: { ...cube, displayText: text } },
      } }, "input", { merge: false });
    }
    return messageList;
  }
  return {
    id: "cube-skills",
    async processInput({ messageList, requestContext, state }) {
      try { return await enrich(messageList, requestContext); }
      catch (error) { state.skillError = error instanceof Error ? error.message : String(error); return messageList; }
    },
    async processInputStep({ messageList, requestContext, state }) {
      if (state.skillError) return messageList;
      try { return await enrich(messageList, requestContext); }
      catch (error) { state.skillError = error instanceof Error ? error.message : String(error); return messageList; }
    },
    processLLMRequest({ state }) {
      // Input-stage exceptions lose their cause in native thread startup. Surface
      // failures at the request boundary, before any provider call, without a tripwire.
      if (state.skillError) throw new Error(String(state.skillError));
    },
  };
}
