import { formatSkillActivation, type Skill } from "@mastra/core/workspace";
import { join } from "node:path";

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function formatActivatedSkill(skill: Skill): string {
  return `This skill's main instructions are already loaded in full; use them directly and do not reload this skill. Use skill_read to read related files when needed, with paths relative to this skill's root. Use skill to load other relevant skills whose instructions are not already in context.\n<skill_instructions name="${escapeXml(skill.name)}" source="${escapeXml(join(skill.path, "SKILL.md"))}">\n${escapeXml(formatSkillActivation(skill))}\n</skill_instructions>`;
}
