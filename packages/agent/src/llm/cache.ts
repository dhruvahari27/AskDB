import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LlmProvider, LlmRequest, LlmResponse } from './types';

export interface CacheStore {
  get(key: string): Promise<LlmResponse | undefined>;
  set(key: string, value: LlmResponse): Promise<void>;
}

export class MemoryCache implements CacheStore {
  private map = new Map<string, LlmResponse>();
  constructor(private max = 2000) {}
  async get(key: string) {
    return this.map.get(key);
  }
  async set(key: string, value: LlmResponse) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(key, value);
  }
}

/** One JSON file per prompt. Survives restarts, so eval reruns are free and reproducible. */
export class FileCache implements CacheStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  private path(key: string) {
    return resolve(this.dir, `${key}.json`);
  }
  async get(key: string) {
    const p = this.path(key);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as LlmResponse;
    } catch {
      return undefined;
    }
  }
  async set(key: string, value: LlmResponse) {
    const p = this.path(key);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, p);
  }
}

export async function createRedisCache(url: string, ttlSeconds = 60 * 60 * 24 * 14): Promise<CacheStore> {
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
  return {
    async get(key) {
      try {
        const v = await redis.get(`askdb:llm:${key}`);
        return v ? (JSON.parse(v) as LlmResponse) : undefined;
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      try {
        await redis.set(`askdb:llm:${key}`, JSON.stringify(value), 'EX', ttlSeconds);
      } catch {
        /* cache is best effort */
      }
    },
  };
}

export class CachedProvider implements LlmProvider {
  hits = 0;
  misses = 0;
  constructor(private inner: LlmProvider, private store: CacheStore) {}
  get name() {
    return this.inner.name;
  }
  get model() {
    return this.inner.model;
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const key = createHash('sha256')
      .update(JSON.stringify([this.inner.name, this.inner.model, req.task, req.system, req.user, req.temperature ?? 0, req.json]))
      .digest('hex');
    const hit = await this.store.get(key);
    if (hit) {
      this.hits++;
      return { ...hit, cached: true };
    }
    this.misses++;
    const res = await this.inner.complete(req);
    await this.store.set(key, res);
    return res;
  }
}
