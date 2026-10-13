export const GLOBAL_ROOT = ".cube";
export const PROJECT_ROOT = [".agents", ".cube", ".claude", ".codex"] as const;
export const CONTEXT_FILE = "AGENTS.md";
export const SKILL_DIR = "skills";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_LMSTUDIO_URL = "http://127.0.0.1:1234/v1";
export const INHERIT_MODEL = "inherit";
export const DEFAULT_WORKSPACE_ONLY = true;
export const DEFAULT_COMMAND_TRUNCATION = { max_bytes: 256 * 1024, max_lines: 200 };
export const DEFAULT_BACKGROUND_TASKS = {
  enabled: true,
  concurrency: 2,
  timeout_ms: 300000,
} as const;
export const DEFAULT_SUBAGENTS = {
  concurrency: 2,
  model: INHERIT_MODEL,
  timeout_ms: 0,
} as const;
export const MEMORY_RETRIEVAL_DEFAULTS = {
  enabled: false,
  model: null,
  revision: null,
  dimensions: null,
  document_prefix: "",
  query_prefix: "",
  provider_options: { document: {}, query: {} },
  chunk: { max_chars: 1024, overlap_chars: 128 },
};
export const MEMORY_RETRIEVAL_LIMITS = {
  options_bytes: 16 * 1024,
  prefix_chars: 512,
  revision_chars: 256,
  max_dimensions: 65536,
  min_chunk_chars: 128,
  max_chunk_chars: 16384,
  manifest_bytes: 16 * 1024 * 1024,
} as const;
export const DURABLE_MEMORY_DEFAULTS = {
  enabled: true,
  model: INHERIT_MODEL,
  min_idle_hours: 6,
  retrieval: MEMORY_RETRIEVAL_DEFAULTS,
} as const;

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
  PERMISSION: "permission.json",
  AGENTS: "AGENTS.md",
} as const;

export const MCP_DEFAULTS = {
  REQUEST_TIMEOUT_MS: 60_000,
  CONNECT_TIMEOUT_MS: 3_000,
  AUTH_TIMEOUT_MS: 300_000,
} as const;

export const HOME_LIMITS = {
  SOUL_MAX_CHARACTERS: 2000,
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
