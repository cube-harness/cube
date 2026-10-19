import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { HomeManager } from "./home-manager.js";
import { ReasoningEffortSchema, type ReasoningEffort } from "./schemas/config.schema.js";

export type SubagentDefinition = {
  name: string;
  description: string;
  instructions: string;
  source: "builtin" | "global" | "project";
  path?: string;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  mcpServers?: string[];
  isolation?: "none" | "worktree";
  model?: string;
  reasoning_effort?: ReasoningEffort;
};

const names = z.array(z.string().trim().min(1)).refine(
  items => new Set(items).size === items.length, "Names must be unique",
);
const metadata = z.object({
  description: z.string().trim().min(1),
  tools: names.optional(),
  disallowedTools: names.optional(),
  skills: names.optional(),
  mcpServers: names.optional(),
  isolation: z.enum(["none", "worktree"]).optional(),
  model: z.string().trim().min(1).optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
}).strict();

export async function loadSubagentDefinitions(
  home: HomeManager,
  projectRoot: string,
  builtins: readonly SubagentDefinition[],
): Promise<{ agents: SubagentDefinition[]; errors: { name: string; source: string; message: string }[] }> {
  const agents = new Map(builtins.map(agent => [agent.name, structuredClone(agent)]));
  const errors = new Map<string, { name: string; source: string; message: string }>();
  for (const [source, directory] of [
    ["global", path.join(home.getRoot(), "agents")],
    ["project", path.join(projectRoot, ".agents", "agents")],
    ["project", path.join(projectRoot, ".cube", "agents")],
  ] as const) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith(".md")) continue;
      const name = entry.name.slice(0, -3);
      const file = path.join(directory, entry.name);
      if (builtins.some(agent => agent.name === name)) {
        errors.set(name, { name, source: file, message: `Agent name "${name}" is reserved by Cube; configure shared model/effort in config.yaml instead.` });
        continue;
      }
      agents.delete(name);
      errors.delete(name);
      try {
        if (!/^[a-z][a-z0-9_-]{0,56}$/.test(name)) throw new Error("Use a lowercase agent filename of at most 57 characters, not a path");
        if (!entry.isFile()) throw new Error("Agent definitions must be regular Markdown files");
        const text = await readFile(file, "utf8");
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
        if (!frontmatter) throw new Error("Expected YAML frontmatter and Markdown instructions");
        const fields = metadata.parse(YAML.parse(frontmatter[1]!));
        const instructions = frontmatter[2]!.trim();
        if (!instructions) throw new Error("Agent instructions must not be empty");
        agents.set(name, { name, source, path: file, instructions, ...fields });
      } catch (error) {
        errors.set(name, { name, source: file, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { agents: [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)), errors: [...errors.values()] };
}
