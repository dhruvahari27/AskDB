import { resolve } from 'node:path';
import { repoRoot, type Config } from '@askdb/shared';
import { CachedProvider, FileCache, MemoryCache, createRedisCache } from './llm/cache';
import { FallbackProvider } from './llm/fallback';
import { GeminiProvider } from './llm/gemini';
import { GroqProvider } from './llm/groq';
import { MockProvider } from './llm/mock';
import type { LlmProvider } from './llm/types';

export interface ProviderOptions {
  /** none: always call the model. file: cache on disk (evals). auto: Redis if REDIS_URL is set, otherwise none. */
  cache?: 'none' | 'file' | 'auto';
  cacheDir?: string;
}

export async function createProvider(cfg: Config, opts: ProviderOptions = {}): Promise<LlmProvider> {
  let base: LlmProvider;
  switch (cfg.LLM_PROVIDER) {
    case 'groq':
      base = new GroqProvider(cfg.GROQ_API_KEY, cfg.GROQ_MODEL);
      break;
    case 'gemini':
      base = new GeminiProvider(cfg.GEMINI_API_KEY, cfg.GEMINI_MODEL);
      if (cfg.GROQ_API_KEY) {
        base = new FallbackProvider(base, new GroqProvider(cfg.GROQ_API_KEY, cfg.GROQ_MODEL));
      }
      break;
    default:
      base = new MockProvider();
  }
  const mode = opts.cache ?? 'auto';
  if (mode === 'file') return new CachedProvider(base, new FileCache(opts.cacheDir ?? resolve(repoRoot, '.cache/llm')));
  if (mode === 'auto' && cfg.REDIS_URL && cfg.LLM_PROVIDER !== 'mock') return new CachedProvider(base, await createRedisCache(cfg.REDIS_URL));
  return base;
}

export { MemoryCache };
