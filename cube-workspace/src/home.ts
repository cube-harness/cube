import {
  constants as fsConstants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { ZodError } from "zod";
import { ConfigSchema, type CubeConfig } from "./schemas/config.schema.js";

const BOOTSTRAP_FILES = ["config.yaml", "SOUL.md", "workspace.json", "mcp.json"] as const;

type BootstrapFile = (typeof BOOTSTRAP_FILES)[number];

export type CubeResult<T> = { ok: true; value: T; warning?: string } | { ok: false; error: string };

export interface AgentRuntimeFiles {
  memoryDatabase: string;
  threadLog: (threadId: string) => string;
}

export interface CubeHome {
  initialize: () => void;
  config: {
    read: () => CubeResult<CubeConfig>;
    write: (config: CubeConfig) => CubeResult<CubeConfig>;
  };
  soul: {
    snapshot: () => CubeResult<string>;
  };
  agentRuntime: AgentRuntimeFiles;
}

const formatZodError = (error: ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const combineWarnings = (...warnings: Array<string | undefined>): string | undefined => {
  const messages = warnings.filter((warning): warning is string => Boolean(warning));
  return messages.length > 0 ? messages.join(" ") : undefined;
};

export const createCubeHome = (
  home: string,
  templateRoot: URL = new URL("./cube-home/", import.meta.url),
): CubeHome => {
  const memoriesDirectory = path.join(home, "memories");
  const logsDirectory = path.join(home, "logs");
  const targets: Record<BootstrapFile, string> = {
    "config.yaml": path.join(home, "config.yaml"),
    "SOUL.md": path.join(home, "SOUL.md"),
    "workspace.json": path.join(home, "workspace.json"),
    "mcp.json": path.join(home, "mcp.json"),
  };
  const templatePath = (fileName: BootstrapFile): string =>
    fileURLToPath(new URL(fileName, templateRoot));

  let packagedConfig: CubeConfig | undefined;
  let packagedSoul: string | undefined;

  const readPackagedConfig = (): CubeConfig => {
    if (packagedConfig) return ConfigSchema.parse(packagedConfig);

    const source = templatePath("config.yaml");
    try {
      packagedConfig = ConfigSchema.parse(parse(readFileSync(source, "utf8")));
      return ConfigSchema.parse(packagedConfig);
    } catch (cause) {
      const detail = cause instanceof ZodError ? formatZodError(cause) : errorMessage(cause);
      throw new Error(`Invalid packaged Cube config at ${source}: ${detail}`, { cause });
    }
  };

  const readPackagedSoul = (): string => {
    if (packagedSoul !== undefined) return packagedSoul;

    const source = templatePath("SOUL.md");
    packagedSoul = readFileSync(source, "utf8");
    if (!packagedSoul.trim()) {
      throw new Error(`Packaged Cube SOUL is empty at ${source}.`);
    }
    return packagedSoul;
  };

  const copyTemplateIfMissing = (fileName: BootstrapFile): void => {
    try {
      copyFileSync(templatePath(fileName), targets[fileName], fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  };

  const initialize = (): void => {
    readPackagedConfig();
    const defaultSoul = readPackagedSoul();
    const defaultSoulLimit = readPackagedConfig().soul.max_characters;
    if (Array.from(defaultSoul).length > defaultSoulLimit) {
      throw new Error(`Packaged Cube SOUL exceeds soul.max_characters (${defaultSoulLimit}).`);
    }

    for (const directory of [home, memoriesDirectory, logsDirectory]) {
      mkdirSync(directory, { recursive: true });
    }
    for (const fileName of BOOTSTRAP_FILES) copyTemplateIfMissing(fileName);
  };

  const readConfig = (): CubeResult<CubeConfig> => {
    initialize();
    const configPath = targets["config.yaml"];
    let raw: string;
    try {
      raw = readFileSync(configPath, "utf8");
    } catch (error) {
      return {
        ok: false,
        error: `Unable to read Cube config at ${configPath}: ${errorMessage(error)}`,
      };
    }

    try {
      return { ok: true, value: ConfigSchema.parse(parse(raw)) };
    } catch (cause) {
      const detail = cause instanceof ZodError ? formatZodError(cause) : errorMessage(cause);
      return {
        ok: true,
        value: readPackagedConfig(),
        warning: `Invalid Cube config at ${configPath}; using packaged defaults for this run: ${detail}`,
      };
    }
  };

  const writeConfig = (config: CubeConfig): CubeResult<CubeConfig> => {
    initialize();
    const validated = ConfigSchema.safeParse(config);
    if (!validated.success) {
      return { ok: false, error: `Invalid Cube config: ${formatZodError(validated.error)}` };
    }

    const configPath = targets["config.yaml"];
    const temporaryPath = `${configPath}.tmp`;
    let temporaryWritten = false;
    try {
      writeFileSync(temporaryPath, stringify(validated.data), "utf8");
      temporaryWritten = true;
      renameSync(temporaryPath, configPath);
      return { ok: true, value: validated.data };
    } catch (error) {
      if (temporaryWritten) {
        try {
          rmSync(temporaryPath, { force: true });
        } catch {
          // Preserve the original write failure as the user-facing error.
        }
      }
      return {
        ok: false,
        error: `Unable to write Cube config at ${configPath}: ${errorMessage(error)}`,
      };
    }
  };

  const snapshotSoul = (): CubeResult<string> => {
    initialize();
    const configResult = readConfig();
    if (!configResult.ok) return configResult;

    const soulPath = targets["SOUL.md"];
    const maxCharacters = configResult.value.soul.max_characters;
    let size: number;
    try {
      size = statSync(soulPath).size;
    } catch (error) {
      return {
        ok: false,
        error: `Unable to inspect Cube SOUL at ${soulPath}: ${errorMessage(error)}`,
      };
    }

    if (size > maxCharacters * 4) {
      return {
        ok: false,
        error: `SOUL.md is too large (${size} bytes); the configured limit is ${maxCharacters} characters.`,
      };
    }

    let content: string;
    try {
      content = readFileSync(soulPath, "utf8");
    } catch (error) {
      return {
        ok: false,
        error: `Unable to read Cube SOUL at ${soulPath}: ${errorMessage(error)}`,
      };
    }

    const characterCount = Array.from(content).length;
    if (characterCount > maxCharacters) {
      return {
        ok: false,
        error: `SOUL.md has ${characterCount} characters; the configured limit is ${maxCharacters}.`,
      };
    }

    if (!content.trim()) {
      const fallback = readPackagedSoul();
      const fallbackCharacters = Array.from(fallback).length;
      if (fallbackCharacters > maxCharacters) {
        return {
          ok: false,
          error: `Packaged SOUL fallback has ${fallbackCharacters} characters; the configured limit is ${maxCharacters}.`,
        };
      }
      return {
        ok: true,
        value: fallback,
        warning: combineWarnings(
          configResult.warning,
          `SOUL.md at ${soulPath} is empty; using packaged instructions for this thread.`,
        ),
      };
    }

    return {
      ok: true,
      value: content,
      warning: configResult.warning,
    };
  };

  return {
    initialize,
    config: { read: readConfig, write: writeConfig },
    soul: { snapshot: snapshotSoul },
    agentRuntime: {
      memoryDatabase: path.join(memoriesDirectory, "memory.sqlite"),
      threadLog: (threadId) => path.join(logsDirectory, `agent-${threadId}.json`),
    },
  };
};
