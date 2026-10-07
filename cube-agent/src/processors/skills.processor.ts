import { isUserAuthoredMessage } from "@mastra/core/agent";
import type { InputProcessor, ProcessInputArgs } from "@mastra/core/processors";
import { RequestContext } from "@mastra/core/request-context";
import { join } from "node:path";
import type { CubeSkills } from "../skills.js";
import { formatActivatedSkill } from "../prompts/skills.prompt.js";

export function findSkillMentions(text: string, knownNames: ReadonlySet<string>): string[] {
  // Exclude fenced and inline code before matching literal catalog names.
  const prose = text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*(?:\n|$)|$(?![\s\S]))/gm, " ")
    .replace(/(`+)[\s\S]*?\1(?!`)/g, " ");
  return [
    ...new Set(
      [...prose.matchAll(/(?:^|[\s([{])\$([a-zA-Z0-9][a-zA-Z0-9_-]*)(?![a-zA-Z0-9_-])/g)]
        .map((match) => match[1]!)
        .filter((name) => knownNames.has(name)),
    ),
  ];
}

export function createSkillsProcessor(skills: CubeSkills): InputProcessor {
  async function activate({
    messageList, requestContext, state, sendSignal,
  }: Pick<ProcessInputArgs, "messageList" | "requestContext" | "state" | "sendSignal">) {
    const inputs = messageList.get.input.db().filter(isUserAuthoredMessage);
    if (!inputs.length) return messageList;
    const snapshot = await skills.snapshot(requestContext ?? new RequestContext());
    const names = new Set(snapshot.catalog.map((skill) => skill.name));
    const delivered = (state.skillActivations ??= new Set<string>()) as Set<string>;
    for (const stored of messageList.get.all.db()) {
      const signal = stored.content.metadata?.signal as { metadata?: { cube?: Record<string, unknown> } } | undefined;
      const cube = signal?.metadata?.cube;
      if (stored.role === "signal" && cube?.kind === "skill-activation") {
        delivered.add(JSON.stringify([cube.triggerMessageId, cube.source]));
      }
    }
    const activations = [];
    for (const message of inputs) {
      const text = message.content.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const mentions = findSkillMentions(text, names);
      if (!mentions.length) continue;
      for (const name of mentions) {
        if (!snapshot.catalog.some((skill) => skill.name === name && skill.enabled)) {
          throw new Error(`Skill "${name}" is disabled. Enable it with /skills.`);
        }
        const skill = await snapshot.enabled.get(name);
        if (!skill) throw new Error(`Cannot load skill "${name}". Check /skills.`);
        const source = join(skill.path, "SKILL.md");
        const key = JSON.stringify([message.id, source]);
        if (!delivered.has(key)) {
          activations.push({ skill, source, key, triggerMessageId: message.id });
        }
      }
    }
    if (activations.length && !sendSignal) {
      throw new Error("Skill activation requires native signal delivery.");
    }
    for (const { skill, source, key, triggerMessageId } of activations) {
      if (delivered.has(key)) continue;
      await sendSignal!({
        type: "reactive",
        tagName: "system-reminder",
        transient: false,
        attributes: { type: "skill-activation", name: skill.name, source },
        metadata: { cube: { kind: "skill-activation", triggerMessageId, source } },
        contents: formatActivatedSkill(skill),
      });
      delivered.add(key);
    }
    return messageList;
  }
  return {
    id: "cube-skills",
    async processInput(args) {
      const { messageList, state } = args;
      try {
        return await activate(args);
      } catch (error) {
        state.skillError = error instanceof Error ? error.message : String(error);
        return messageList;
      }
    },
    async processInputStep(args) {
      const { messageList, state } = args;
      if (state.skillError) return messageList;
      try {
        return await activate(args);
      } catch (error) {
        state.skillError = error instanceof Error ? error.message : String(error);
        return messageList;
      }
    },
    processLLMRequest({ state }) {
      // Input-stage exceptions lose their cause in native thread startup. Surface
      // failures at the request boundary, before any provider call, without a tripwire.
      if (state.skillError) throw new Error(String(state.skillError));
    },
  };
}
