import { createHash } from "node:crypto";
import { z } from "zod";
import { MCP_DEFAULTS } from "../constants.js";

const common = {
  disabled: z.boolean().default(false),
  timeout: z.number().int().positive().default(MCP_DEFAULTS.REQUEST_TIMEOUT_MS),
};
const strings = z.record(z.string(), z.string());
const stdio = z.object({
  ...common,
  type: z.literal("stdio").optional(),
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  env: strings.default({}),
  cwd: z.string().min(1).optional(),
  url: z.never().optional(),
  oauth: z.never().optional(),
}).transform((value) => ({ ...value, type: "stdio" as const }));
const http = z.object({
  ...common,
  type: z.enum(["http", "streamable-http", "streamableHttp", "sse"]).optional(),
  url: z.string().url().refine((value) => /^https?:/i.test(value), "URL must use HTTP or HTTPS"),
  headers: strings.default({}),
  oauth: z.object({
    client_id: z.string().trim().min(1),
    client_secret: z.string().min(1).optional(),
  }).strict().optional(),
  connectTimeout: z.number().int().positive().default(MCP_DEFAULTS.CONNECT_TIMEOUT_MS),
  command: z.never().optional(),
}).refine((value) => !value.oauth || !Object.keys(value.headers).some((key) => key.toLowerCase() === "authorization"),
  "Use either OAuth client configuration or a static Authorization header, not both.")
  .transform((value) => ({ ...value, type: "http" as const, url: new URL(value.url).href }));

export const McpServerSchema = z.union([stdio, http]);
export const McpDocumentSchema = z.object({
  mcpServers: z.record(z.string().min(1), z.unknown()),
}).passthrough();
export type McpServerConfig = z.infer<typeof McpServerSchema>;
export type McpConfigSnapshot = {
  servers: Record<string, McpServerConfig>;
  errors: Record<string, string>;
  error?: string;
};

export const parseMcpConfig = (document: unknown): McpConfigSnapshot => {
  const result: McpConfigSnapshot = { servers: {}, errors: {} };
  const parsed = McpDocumentSchema.safeParse(document);
  if (!parsed.success) return { ...result, error: "Invalid mcp.json: expected an mcpServers object." };
  for (const [name, raw] of Object.entries(parsed.data.mcpServers)) {
    const server = McpServerSchema.safeParse(raw);
    if (server.success) result.servers[name] = server.data;
    else result.errors[name] = "Invalid server configuration: use command/args/env for stdio or url/headers for HTTP, with positive timeouts and a matching type. OAuth requires client_id, an optional non-empty client_secret, and no static Authorization header.";
  }
  return result;
};

export const mcpConnectionKey = (config: McpServerConfig): string => {
  const { disabled: _disabled, ...connection } = config;
  const sorted = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
  const normalized = config.type === "stdio"
    ? { ...connection, env: sorted(config.env) }
    : { ...connection, headers: sorted(config.headers) };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
};
