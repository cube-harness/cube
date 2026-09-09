export const GLOBAL_ROOT = ".cube";
export const PROJECT_ROOT = [".agents", ".cube", ".claude", ".codex"] as const;
export const CONTEXT_FILE = "AGENTS.md";
export const SKILL_DIR = "skills";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_LMSTUDIO_URL = "http://127.0.0.1:1234/v1";

export const HOME_PATHS = {
  ROOT: GLOBAL_ROOT,
  MEMORIES: "memories",
  LOGS: "logs",
  SKILLS: SKILL_DIR,
} as const;

export const HOME_FILES = {
  MEMORY_DB: "memory.sqlite",
  AUTH: "auth.json",
  CONFIG: "config.yaml",
  HISTORY: "history.jsonl",
  MCP: "mcp.json",
  MODEL_CATALOG: "model-catalog.json",
  SOUL: "SOUL.md",
  WORKSPACE: "workspace.json",
  AGENTS: "AGENTS.md"
} as const;

export const HOME_LIMITS = {
  SOUL_MAX_CHARACTERS: 20000,
  MODEL_CATALOG_TTL_MS: 24 * 60 * 60 * 1000,
} as const;

export const WORKSPACE_PATHS = {
  ROOT: PROJECT_ROOT,
  SKILLS: PROJECT_ROOT.map((dir) => `${dir}/${SKILL_DIR}`),
} as const;

export const WORKSPACE_FILES = {
  CONTEXT: CONTEXT_FILE,
} as const;

export const API_KEY_PROVIDERS = {
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
  xai: "xAI",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot",
  openrouter: "OpenRouter",
  mistral: "Mistral",
  nvidia: "Nvidia",
  poolside: "Poolside",
  zai: "Z.AI",
  "zai-coding-plan": "Z.AI Coding Plan",
  alibaba: "Alibaba",
  "alibaba-coding-plan": "Alibaba Coding Plan",
  huggingface: "Hugging Face",
  groq: "Groq",
} as const;

export type HomePathKey = keyof typeof HOME_PATHS;
export type HomePath = (typeof HOME_PATHS)[HomePathKey];

export type HomeFileKey = keyof typeof HOME_FILES;
export type HomeFile = (typeof HOME_FILES)[HomeFileKey];

export type HomeLimitKey = keyof typeof HOME_LIMITS;
export type HomeLimit = (typeof HOME_LIMITS)[HomeLimitKey];

export type WorkspacePathKey = keyof typeof WORKSPACE_PATHS;
export type WorkspacePathsConfig = typeof WORKSPACE_PATHS;

export type WorkspaceFileKey = keyof typeof WORKSPACE_FILES;
export type WorkspaceFilesConfig = typeof WORKSPACE_FILES;

export type ProjectRootDir = (typeof PROJECT_ROOT)[number];
