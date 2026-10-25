import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
import os from 'node:os';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const ratio = (fallback: number, min: number, max: number) =>
  z.coerce.number().min(min).max(max).default(fallback);
const schema = z.object({
  LABOR_API_KEY: z.string().default(''),
  LABOR_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  LABOR_MODEL: z.string().min(1).default('deepseek-flash'),
  LABOR_CACHE_MODE: z.enum(['local', 'previous_response_id']).default('local'),
  LABOR_REASONING_EFFORT: z.enum(['none', 'low', 'high', 'max']).default('high'),
  LABOR_MAX_OUTPUT_TOKENS: integer(32768, 256, 131072),
  LABOR_CONTEXT_LIMIT_TOKENS: integer(1048576, 4096, 8000000),
  LABOR_CONTEXT_WARN_RATIO: ratio(0.9, 0.5, 0.99),
  LABOR_TOOL_CONTEXT_CHARS: integer(4000, 1000, 24000),
  LABOR_REQUEST_TIMEOUT_MS: integer(180000, 1000, 1800000),
  LABOR_WORKSPACE: z.string().default('.'),
  LABOR_DATA_DIR: z.string().default('.labor-agent'),
  LABOR_PORT: integer(3210, 1, 65535),
  LABOR_BASH_PATH: z.string().optional(),
  LABOR_CODEX_COMMAND: z.string().default('codex'),
  LABOR_CODEX_HOME: z.string().optional(),
  LABOR_CODEX_SQLITE_HOME: z.string().optional(),
  LABOR_CODEX_DIRECT: z.enum(['true', 'false']).default('false'),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  // Keep file settings out of process.env: a long-lived MCP process must not
  // pass stale .env values to a newly spawned backend after a settings edit.
  const file = path.join(projectRoot, '.env');
  const effective = { ...(fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {}), ...env };
  const c = schema.parse({ ...effective,
    LABOR_API_KEY: effective.LABOR_API_KEY || effective.DEEPSEEK_API_KEY || '',
    LABOR_BASE_URL: effective.LABOR_BASE_URL || effective.DEEPSEEK_BASE_URL || undefined,
  });
  const url = new URL(c.LABOR_BASE_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('LABOR_BASE_URL 必须是没有账号、查询参数的 HTTP(S) 地址。');
  const dataDir = path.resolve(projectRoot, c.LABOR_DATA_DIR);
  return {
    projectRoot, apiKey: c.LABOR_API_KEY.trim(),
    baseUrl: c.LABOR_BASE_URL.replace(/\/+$/, ''), model: c.LABOR_MODEL,
    cacheMode: c.LABOR_CACHE_MODE, reasoningEffort: c.LABOR_REASONING_EFFORT,
    maxOutputTokens: c.LABOR_MAX_OUTPUT_TOKENS, contextLimitTokens: c.LABOR_CONTEXT_LIMIT_TOKENS,
    contextWarnRatio: c.LABOR_CONTEXT_WARN_RATIO,
    toolContextChars: c.LABOR_TOOL_CONTEXT_CHARS,
    requestTimeout: c.LABOR_REQUEST_TIMEOUT_MS,
    workspace: path.resolve(projectRoot, c.LABOR_WORKSPACE),
    dataDir, port: c.LABOR_PORT,
    bashPath: c.LABOR_BASH_PATH,
    codexCommand: c.LABOR_CODEX_COMMAND,
    codexHome: c.LABOR_CODEX_HOME ? path.resolve(projectRoot, c.LABOR_CODEX_HOME) : path.join(dataDir, 'codex-accounts', 'default'),
    codexSqliteHome: c.LABOR_CODEX_SQLITE_HOME ? path.resolve(projectRoot, c.LABOR_CODEX_SQLITE_HOME) : path.join(os.homedir(), '.codex'),
    codexDirect: c.LABOR_CODEX_DIRECT === 'true',
  };
}
export type Config = ReturnType<typeof loadConfig>;
