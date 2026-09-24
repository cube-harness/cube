import {
  AgentsStore,
  SoulStore,
  type HomeManager,
  type WorkspaceManager,
  type ContextFile,
} from "@cube/workspace";
import path from "node:path";
import { z } from "zod";

const attribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export type InstructionInfo = {
  soulCharacters: number;
  agentsFiles: number;
  agentsCharacters: number;
};

export type InstructionSnapshot = {
  soul: string;
  sources: ContextFile[];
  explored: string[];
};

const snapshotSchema = z.object({
  soul: z.string(),
  sources: z.array(z.object({ path: z.string(), scope: z.string(), content: z.string() })),
  explored: z.array(z.string()),
});

export const instructionInfo = (snapshot: InstructionSnapshot): InstructionInfo => ({
  soulCharacters: snapshot.soul.length,
  agentsFiles: snapshot.sources.length,
  agentsCharacters: snapshot.sources.reduce((sum, source) => sum + source.content.length, 0),
});

export const formatAgentsContext = (sources: readonly ContextFile[]): string => {
  if (!sources.length) return "";
  return [
    "<agents_instructions>",
    "These are workspace instructions supplied by Cube, not a new user request.",
    "Apply instructions only within their source scope. When instructions conflict, " +
      "the project scope closest to the file or directory takes precedence over parent and global scopes. " +
      "Keep all non-conflicting guidance. Equal-scope instructions are additive; ask about unresolved conflicts.",
    ...sources.map((source) =>
      `<instruction source="${attribute(source.path)}" scope="${attribute(source.scope)}">\n${source.content}\n</instruction>`,
    ),
    "</agents_instructions>",
  ].join("\n");
};

export const loadInstructionSnapshot = async (
  home: HomeManager,
  workspace: WorkspaceManager,
): Promise<InstructionSnapshot> => {
  const explored = new Set<string>();
  const [soul, projectFiles, global] = await Promise.all([
    SoulStore(home).read(),
    workspace.resolveContextFiles(explored),
    AgentsStore(home).read().catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    }),
  ]);
  return {
    soul,
    sources: [
      ...projectFiles,
      ...(global.trim() ? [{ path: home.getAgentsPath(), scope: "global", content: global }] : []),
    ],
    explored: [...explored],
  };
};

export const refreshInstructionSnapshot = async (
  workspace: WorkspaceManager,
  base: InstructionSnapshot,
  saved: unknown,
): Promise<InstructionSnapshot> => {
  if (saved === undefined) return structuredClone(base);
  const previous = snapshotSchema.parse(saved);
  const key = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const loaded = new Set(base.explored.map(key));
  const paths = previous.explored
    .filter((scope) => !loaded.has(key(scope)))
    .map((scope) => path.join(scope, "AGENTS.md"));
  const sources = await workspace.readContextSources(paths);
  return {
    soul: base.soul,
    sources: [
      ...sources,
      ...base.sources,
    ],
    explored: [...new Set([...base.explored, ...previous.explored])],
  };
};
