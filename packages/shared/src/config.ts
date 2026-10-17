import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/** Walk up from this file until we find the repo root (the folder holding the workspaces package.json). */
export function findRepoRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, 'warehouse')) && existsSync(resolve(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const repoRoot = findRepoRoot();

let loaded = false;
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const envPath = resolve(repoRoot, '.env');
  if (existsSync(envPath)) dotenv.config({ path: envPath });
}

const ConfigSchema = z.object({
  APP_DATABASE_URL: z.string().default('postgres://askdb:askdb@localhost:5433/askdb_app'),
  WAREHOUSE_ADMIN_URL: z.string().default('postgres://askdb:askdb@localhost:5433/askdb_warehouse'),
  WAREHOUSE_READONLY_URL: z.string().default('postgres://askdb_ro:askdb_ro@localhost:5433/askdb_warehouse'),
  PORT: z.coerce.number().default(4711),
  CLIENT_ORIGIN: z.string().default('http://localhost:4710'),
  JWT_SECRET: z.string().default('dev-only-insecure-secret-change-me'),
  DAILY_TOKEN_BUDGET: z.coerce.number().default(200000),
  ASK_RATE_LIMIT_PER_MIN: z.coerce.number().default(20),
  LLM_PROVIDER: z.enum(['mock', 'groq', 'gemini']).default('mock'),
  GROQ_API_KEY: z.string().default(''),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.0-flash'),
  REDIS_URL: z.string().default(''),
  STATEMENT_TIMEOUT_MS: z.coerce.number().default(5000),
  MAX_RESULT_ROWS: z.coerce.number().default(500),
  MAX_PLAN_COST: z.coerce.number().default(5_000_000),
  NODE_ENV: z.string().default('development'),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | undefined;
export function getConfig(): Config {
  loadEnv();
  if (!cached) cached = ConfigSchema.parse(process.env);
  return cached;
}

/** For tests: drop the cached config so changed env vars are re-read. */
export function resetConfigForTests(): void {
  cached = undefined;
}
