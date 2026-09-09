import {
  AgentsStore,
  ContextFile,
  CubeHome,
  CubeWorkspace,
  HomeManager,
  SoulStore,
} from "@cube/workspace";

export interface MemoryListing {
  path: string;
  description: string;
}

export interface BuildSystemPromptOptions {
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  soul?: string;
  cwd: string;
  contextFiles?: ContextFile[];
  memoryListing?: MemoryListing[];
}

// Một "part" tương ứng 1 system message block khi gửi API.
// static=true => phần này gộp vào breakpoint cache, hiếm khi đổi.
// static=false => phần cuối, đổi mỗi turn, KHÔNG cache.
export interface SystemPromptPart {
  content: string;
  static: boolean;
}

const formatContextFiles = (files: ContextFile[]): string => {
  if (files.length === 0) return "";
  const blocks = files
    .map((f) => `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`)
    .join("\n\n");
  return `\n\n<project_context>\n\nProject-specific instructions and guidelines (if files conflict, project-root instructions take precedence over global ones, and nested per-tool instructions take precedence over project-root):\n\n${blocks}\n\n</project_context>\n`;
};

const formatMemoryListing = (items: MemoryListing[]): string => {
  if (items.length === 0) return "";
  const lines = items.map((m) => `- ${m.path}: ${m.description}`).join("\n");
  return `\n\n<memory_listing>\nFiles in memory (call memory_read(path) for full content):\n${lines}\n</memory_listing>\n`;
};

/**
 * Thứ tự PHẢI giữ nguyên vì ảnh hưởng prompt cache:
 * [1] tools + guidelines      — tĩnh tuyệt đối, không đổi giữa các turn
 * [2] soul                    — tĩnh, chỉ đổi khi user sửa SOUL.md
 * [3] contextFiles            — tĩnh trong 1 session, chỉ đổi khi mở project khác
 * [4] cwd                     — tĩnh trong 1 session
 * ---- breakpoint đặt NGAY SAU đây ----
 * [5] memoryListing           — ĐỘNG, đổi mỗi lần agent ghi memory → không cache
 *
 * Trả về mảng parts thay vì string để caller (nơi gọi Anthropic API qua Mastra/AI SDK)
 * tự set cacheControl cho phần static, không set cho phần cuối.
 */
export const buildSystemPrompt = (options: BuildSystemPromptOptions): SystemPromptPart[] => {
  const {
    selectedTools = ["read", "edit", "write", "bash"],
    toolSnippets = {},
    promptGuidelines = [],
    soul,
    cwd,
    contextFiles = [],
    memoryListing = [],
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

  // [1] + [2] + [3] + [4]: gộp chung 1 part static — cache hit toàn bộ nếu
  // không có gì trong các phần này đổi giữa 2 turn liên tiếp.
  const base = `You are Cube, an autonomous coding agent operating in a terminal.

Available tools:
${toolsList}

Guidelines:
${[...guidelines].map((g) => `- ${g}`).join("\n")}`;

  const soulSection = soul ? `\n\n${soul}` : "";
  const contextSection = formatContextFiles(contextFiles);
  const cwdLine = `\nCurrent working directory: ${cwd.replace(/\\/g, "/")}`;

  const staticPart: SystemPromptPart = {
    content: base + soulSection + contextSection + cwdLine,
    static: true,
  };

  // [5]: memory listing — part riêng, không static, đặt cuối cùng
  const dynamicPart: SystemPromptPart = {
    content: formatMemoryListing(memoryListing),
    static: false,
  };

  return dynamicPart.content ? [staticPart, dynamicPart] : [staticPart];
};

export interface ComposeSystemPromptOptions {
  home?: HomeManager;
  cwd?: string;
  toolSnippets: Record<string, string>;
  selectedTools?: string[];
  promptGuidelines?: string[];
  memoryListing?: MemoryListing[];
}

export const composeSystemPrompt = async (
  opts: ComposeSystemPromptOptions,
): Promise<SystemPromptPart[]> => {
  const home = opts.home ?? CubeHome();
  const workspace = CubeWorkspace(home, opts.cwd);

  const [projectFiles, globalFile, { root }, soul] = await Promise.all([
    workspace.resolveContextFiles(),
    AgentsStore(home)
      .read()
      .catch((err) => {
        if (err.code === "ENOENT") return undefined;
        throw err;
      }),
    workspace.getPaths(),
    SoulStore(home)
      .read()
      .catch((err) => {
        if (err.code === "ENOENT") return undefined;
        throw err;
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
    memoryListing: opts.memoryListing ?? [],
  });
};
