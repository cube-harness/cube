import {
  AgentsStore,
  ContextFile,
  CubeHome,
  CubeWorkspace,
  HomeManager,
  SoulStore,
} from "@cube/workspace";

export interface BuildSystemPromptOptions {
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  soul?: string;
  cwd: string;
  contextFiles?: ContextFile[];
}

const formatContextFiles = (files: ContextFile[]): string => {
  if (files.length === 0) return "";
  const blocks = files
    .map((f) => `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`)
    .join("\n\n");
  return `\n\n<project_context>\n\nProject-specific instructions and guidelines (if files conflict, project-root instructions take precedence over global ones, and nested per-tool instructions take precedence over project-root):\n\n${blocks}\n\n</project_context>\n`;
};

export const buildSystemPrompt = (options: BuildSystemPromptOptions): string => {
  const {
    selectedTools = ["read", "edit", "write", "bash"],
    toolSnippets = {},
    promptGuidelines = [],
    soul,
    cwd,
    contextFiles = [],
  } = options;

  const visibleTools = selectedTools.filter((t) => toolSnippets[t]);
  const toolsList = visibleTools.length
    ? visibleTools.map((t) => `- ${t}: ${toolSnippets[t]}`).join("\n")
    : "(none)";

  const guidelines = new Set<string>([
    "Be concise in your responses",
    "Show file paths clearly when working with files",
  ]);
  for (const g of promptGuidelines) {
    const trimmed = g.trim();
    if (trimmed) guidelines.add(trimmed);
  }

  const base = `You are Cube, an autonomous coding agent operating in a terminal.

Available tools:
${toolsList}

Guidelines:
${[...guidelines].map((g) => `- ${g}`).join("\n")}`;

  const soulSection = soul ? `\n\n${soul}` : "";
  const contextSection = formatContextFiles(contextFiles);
  const cwdLine = `\nCurrent working directory: ${cwd.replace(/\\/g, "/")}`;

  return base + soulSection + contextSection + cwdLine;
};

export interface ComposeSystemPromptOptions {
  home?: HomeManager;
  cwd?: string;
  toolSnippets: Record<string, string>;
  selectedTools?: string[];
  promptGuidelines?: string[];
}

export const composeSystemPrompt = async (opts: ComposeSystemPromptOptions): Promise<string> => {
  const home = opts.home ?? CubeHome();
  const workspace = CubeWorkspace(home, opts.cwd);

  const [projectFiles, globalFile, { root }, soul] = await Promise.all([
    workspace.resolveContextFiles(),
    AgentsStore(home)
      .read()
      .catch((err) => {
        if (err.code === "ENOENT") return undefined; // chưa có file — hợp lệ, không phải lỗi
        throw err; // lỗi khác (parse, quyền đọc...) — ném lên cho runtime xử lý
      }),
    workspace.getPaths(),
    SoulStore(home)
      .read()
      .catch((err) => {
        if (err.code === "ENOENT") return undefined;
        throw err; // bao gồm cả lỗi "exceeds max length" từ SoulStore.validateCharacters
      }),
  ]);

  const contextFiles: ContextFile[] = globalFile
    ? [{ path: home.getAgentsPath(), content: globalFile }, ...projectFiles]
    : projectFiles;

  return buildSystemPrompt({
    cwd: root,
    contextFiles,
    toolSnippets: opts.toolSnippets,
    selectedTools: opts.selectedTools,
    promptGuidelines: opts.promptGuidelines,
    soul,
  });
};
