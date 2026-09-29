import { formatSkillActivation, type Skill } from "@mastra/core/workspace";
import { join } from "node:path";

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function formatActivatedSkill(skill: Skill): string {
  return `The following skill instructions are already loaded in full. Use them directly; do not call skill or reread SKILL.md merely to activate them. Read supporting files when needed.\n<skill_instructions name="${escapeXml(skill.name)}" source="${escapeXml(join(skill.path, "SKILL.md"))}">\n${escapeXml(formatSkillActivation(skill))}\n</skill_instructions>`;
}
