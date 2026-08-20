export const HOME_PATHS = {
  home: ".cube",
  memories: "memories",
  logs: "logs",
  skills: "skills",
} as const;

export const HOME_FILES = {
  memoryDb: "memory.sqlite",
  auth: "auth.json",
  config: "config.yaml",
  history: "history.jsonl",
  mcp: "mcp.json",
  modelCatalog: "model-catalog.json",
  soul: "SOUL.md",
  workspace: "workspace.json",
} as const;

export const HOME_LIMITS = {
  soulMaxCharacters: 20000,
} as const;

export type HomePath = (typeof HOME_PATHS)[keyof typeof HOME_PATHS];
export type HomeFile = (typeof HOME_FILES)[keyof typeof HOME_FILES];
