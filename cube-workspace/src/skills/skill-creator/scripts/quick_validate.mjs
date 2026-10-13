#!/usr/bin/env node
// Adapted from OpenAI's Codex skill-creator (Apache-2.0) for Node and Cube. See ../license.txt.
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

function proseOnly(body) {
  let marker;
  let length = 0;
  return body.split("\n").filter(line => {
    const fence = /^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (!marker) { marker = fence[1][0]; length = fence[1].length; }
      else if (fence[1][0] === marker && fence[1].length >= length && !fence[2].trim()) marker = undefined;
      return false;
    }
    return !marker;
  }).join("\n");
}

export async function validateSkill(directory) {
  const root = await realpath(directory);
  const content = (await readFile(path.join(root, "SKILL.md"), "utf8")).replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(content);
  if (!match) throw new Error("SKILL.md requires YAML frontmatter delimited by ---.");
  const metadata = YAML.parse(match[1]);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Frontmatter must be a mapping.");
  const { name, description } = metadata;
  if (typeof name !== "string" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    throw new Error("name must be 1–64 lowercase letters, digits and single hyphens.");
  if (name !== path.basename(root)) throw new Error("Skill name must match the directory name.");
  if (typeof description !== "string" || !description.trim() || description.length > 1024)
    throw new Error("description must be a nonblank string of at most 1024 characters.");
  if (metadata.license != null && typeof metadata.license !== "string") throw new Error("license must be a string.");
  if (metadata.metadata != null && (typeof metadata.metadata !== "object" || Array.isArray(metadata.metadata)))
    throw new Error("metadata must be a mapping.");
  if (metadata["user-invocable"] !== undefined && typeof metadata["user-invocable"] !== "boolean")
    throw new Error("user-invocable must be a boolean.");
  if (!match[2].trim()) throw new Error("Skill instructions must not be empty.");
  const prose = proseOnly(match[2]);
  if (description.trim().startsWith("[TODO:") || /^ {0,3}\[TODO:[^\n]*\][ \t]*$/m.test(prose))
    throw new Error("Skill contains an unfinished TODO scaffold placeholder.");

  for (const link of prose.matchAll(/\[[^\]\n]+\]\(<?([^\s)>]+)>?\)/g)) {
    const href = link[1].split("#")[0];
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) continue;
    const target = path.resolve(root, decodeURIComponent(href));
    const actual = await realpath(target).catch(() => { throw new Error(`Missing relative resource: ${href}`); });
    const relative = path.relative(root, actual);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(`Relative resource escapes the skill directory: ${href}`);
  }
  return "Authoring checks passed. Verify Cube native loading and real task behavior separately.";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node quick_validate.mjs <skill-directory>");
    console.log(await validateSkill(process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
